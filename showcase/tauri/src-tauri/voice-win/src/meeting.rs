// Transcribe short stretches from each WAV and put them on the recording's shared clock.

#[cfg(windows)]
pub mod capture;

use crate::{emit, load_model_with_threads, RATE};
use hound::WavReader;
use parakeet_rs::{TimestampMode, Transcriber};
use serde_json::json;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::Path;

pub const TRACKS: [&str; 2] = ["mic", "system"];
const FRAME: usize = RATE as usize / 50;
const PAUSE: usize = RATE as usize * 3 / 5;
const LIMIT: usize = RATE as usize * 24;
const LEAD: usize = RATE as usize / 5;

// One bounded chunk and a short silence before it. Long stretches of silence never reach Parakeet.
#[derive(Default)]
struct Chunks {
    position: usize,
    start: usize,
    quiet: usize,
    lead: Vec<f32>,
    audio: Vec<f32>,
}

impl Chunks {
    fn push(&mut self, frame: &[f32]) -> Option<(usize, Vec<f32>)> {
        let speech =
            frame.iter().map(|s| s * s).sum::<f32>() > frame.len() as f32 * 0.003_f32.powi(2);
        if self.audio.is_empty() {
            if !speech {
                self.lead.extend_from_slice(frame);
                let old = self.lead.len().saturating_sub(LEAD);
                self.lead.drain(..old);
                self.position += frame.len();
                return None;
            }
            self.start = self.position - self.lead.len();
            self.audio.append(&mut self.lead);
        }
        self.position += frame.len();
        self.audio.extend_from_slice(frame);
        self.quiet = if speech { 0 } else { self.quiet + frame.len() };
        if self.quiet >= PAUSE {
            self.lead
                .extend_from_slice(&self.audio[self.audio.len() - LEAD..]);
            self.audio.truncate(self.audio.len() - self.quiet + LEAD);
            return self.take();
        }
        if self.audio.len() >= LIMIT {
            return self.take();
        }
        None
    }

    fn take(&mut self) -> Option<(usize, Vec<f32>)> {
        self.quiet = 0;
        (!self.audio.is_empty()).then(|| (self.start, std::mem::take(&mut self.audio)))
    }
}

#[derive(Debug, PartialEq)]
struct Segment {
    start: f64,
    end: f64,
    text: String,
    track: &'static str,
}

fn merge(mut parts: Vec<Segment>) -> Vec<Segment> {
    parts.sort_by(|a, b| {
        a.start
            .total_cmp(&b.start)
            .then_with(|| a.track.cmp(b.track))
    });
    let mut merged: Vec<Segment> = Vec::new();
    for part in parts {
        if let Some(last) = merged.last_mut().filter(|last| {
            last.track == part.track && part.start - last.end < 0.6 && part.end - last.start <= 30.0
        }) {
            last.end = last.end.max(part.end);
            last.text.push(' ');
            last.text.push_str(&part.text);
        } else {
            merged.push(part);
        }
    }
    merged
}

pub fn transcribe(model: &Path, folder: &Path) -> Result<(), Box<dyn std::error::Error>> {
    emit(json!({ "type": "meeting_progress", "pct": 0 }));
    // Leave CPU time for the helper that's still handling the talk keys.
    let threads = std::thread::available_parallelism()
        .map(|n| n.get() / 4)
        .unwrap_or(1)
        .clamp(1, 4);
    let mut asr = load_model_with_threads(model, threads)?;
    let mut tracks = Vec::new();
    for track in TRACKS {
        let reader = WavReader::open(folder.join(format!("{track}.wav")))?;
        let spec = reader.spec();
        if spec.sample_rate != RATE
            || spec.channels != 1
            || spec.bits_per_sample != 16
            || spec.sample_format != hound::SampleFormat::Int
        {
            return Err("Expected 16 kHz mono PCM meeting audio".into());
        }
        tracks.push((track, reader));
    }
    let total: u64 = tracks
        .iter()
        .map(|(_, reader)| u64::from(reader.duration()))
        .sum();
    let mut done = 0;
    let mut last_pct = 0;
    let mut parts = Vec::new();
    for (track, mut reader) in tracks {
        let mut chunks = Chunks::default();
        let mut samples = reader.samples::<i16>();
        let mut frame = Vec::with_capacity(FRAME);
        let mut decode =
            |(start, mut audio): (usize, Vec<f32>)| -> Result<(), Box<dyn std::error::Error>> {
                let offset = start as f64 / f64::from(RATE);
                let duration = audio.len() as f64 / f64::from(RATE);
                audio.resize(audio.len().max(LEAD), 0.0);
                let result =
                    asr.transcribe_samples(audio, RATE, 1, Some(TimestampMode::Sentences))?;
                for token in result.tokens {
                    let text = token.text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let start = f64::from(token.start).clamp(0.0, duration);
                    let end = f64::from(token.end).clamp(start, duration);
                    parts.push(Segment {
                        start: offset + start,
                        end: offset + end,
                        text: text.into(),
                        track,
                    });
                }
                Ok(())
            };
        loop {
            frame.clear();
            for sample in samples.by_ref().take(FRAME) {
                frame.push(f32::from(sample?) / 32768.0);
            }
            if frame.is_empty() {
                break;
            }
            if let Some(chunk) = chunks.push(&frame) {
                decode(chunk)?;
            }
            done += frame.len() as u64;
            let pct = (100 * done / total.max(1)).min(99);
            if pct > last_pct {
                last_pct = pct;
                emit(json!({ "type": "meeting_progress", "pct": pct }));
            }
        }
        if let Some(chunk) = chunks.take() {
            decode(chunk)?;
        }
    }
    let segments: Vec<_> = merge(parts)
        .into_iter()
        .map(|s| json!({ "start": s.start, "end": s.end, "text": s.text, "track": s.track }))
        .collect();
    let temp = folder.join("transcript.json.tmp");
    {
        let mut file = BufWriter::new(fs::File::create(&temp)?);
        serde_json::to_writer(&mut file, &json!({ "segments": segments }))?;
        file.flush()?;
    }
    fs::rename(temp, folder.join("transcript.json"))?;
    emit(json!({ "type": "meeting_progress", "pct": 100 }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_keep_offsets_through_silence_and_cap_continuous_speech() {
        let mut chunks = Chunks::default();
        let silent = [0.0; FRAME];
        let speech = [0.1; FRAME];
        for _ in 0..100 {
            assert!(chunks.push(&silent).is_none());
        }
        for _ in 0..25 {
            assert!(chunks.push(&speech).is_none());
        }
        let (offset, audio) = (0..30).find_map(|_| chunks.push(&silent)).unwrap();
        assert_eq!(offset, 100 * FRAME - LEAD);
        assert_eq!(audio.len(), 25 * FRAME + 2 * LEAD);
        let (offset, audio) = (0..(LIMIT / FRAME))
            .find_map(|_| chunks.push(&speech))
            .unwrap();
        assert_eq!(offset, 155 * FRAME - LEAD);
        assert_eq!(audio.len(), LIMIT);
        assert!(chunks.take().is_none());
    }

    #[test]
    fn merges_nearby_segments_in_order_without_crossing_tracks() {
        let segment = |start, end, track, text: &str| Segment {
            start,
            end,
            track,
            text: text.into(),
        };
        let merged = merge(vec![
            segment(3.0, 4.0, "mic", "Last."),
            segment(0.0, 0.8, "mic", "First."),
            segment(1.0, 1.2, "mic", "Next."),
            segment(1.3, 2.9, "system", "Computer."),
        ]);
        assert_eq!(
            merged,
            vec![
                segment(0.0, 1.2, "mic", "First. Next."),
                segment(1.3, 2.9, "system", "Computer."),
                segment(3.0, 4.0, "mic", "Last."),
            ]
        );
    }
}
