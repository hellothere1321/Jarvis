// WASAPI input and render loopback, streamed to WAV on a shared recording clock.

use super::TRACKS;
use crate::{audio::Resampler, emit, RATE};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, DeviceId, FromSample, SampleFormat, SizedSample, Stream};
use hound::{SampleFormat::Int, WavSpec, WavWriter};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender},
    Arc, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows_sys::Win32::{Foundation::RECT, UI::WindowsAndMessaging::*};

const RATE_USIZE: usize = RATE as usize;
const CLOCK_TOLERANCE: usize = RATE_USIZE / 16;
const QUEUE: usize = 256;
type Clock = Arc<OnceLock<Instant>>;

fn frames(time: Duration) -> usize {
    (time.as_secs_f64() * f64::from(RATE)) as usize
}

struct Packet {
    start: usize,
    samples: Vec<f32>,
}

struct Wave {
    writer: WavWriter<BufWriter<File>>,
    written: usize,
}

impl Wave {
    fn new(path: &Path) -> Result<Self, hound::Error> {
        let file = OpenOptions::new().write(true).create_new(true).open(path)?;
        let writer = WavWriter::new(
            BufWriter::new(file),
            WavSpec {
                channels: 1,
                sample_rate: RATE,
                bits_per_sample: 16,
                sample_format: Int,
            },
        )?;
        Ok(Self { writer, written: 0 })
    }

    fn pad_to(&mut self, end: usize) -> Result<(), hound::Error> {
        for _ in self.written..end {
            self.writer.write_sample(0_i16)?;
        }
        self.written = self.written.max(end);
        Ok(())
    }

    fn append(&mut self, packet: Packet, limit: usize) -> Result<(), hound::Error> {
        // Keep contiguous audio contiguous when timestamps have a little jitter.
        let start = if self.written.abs_diff(packet.start) <= CLOCK_TOLERANCE {
            self.written
        } else {
            packet.start
        };
        self.pad_to(start.min(limit))?;
        let skip = self.written - start.min(self.written);
        for s in packet
            .samples
            .into_iter()
            .skip(skip)
            .take(limit.saturating_sub(self.written))
        {
            self.writer
                .write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16)?;
            self.written += 1;
        }
        Ok(())
    }
}

struct Input {
    stream: Stream,
    device: DeviceId,
    packets: Receiver<Packet>,
    failed: Arc<AtomicBool>,
}

impl Input {
    fn open(device: Device, clock: Clock, loopback: bool) -> Result<Self, cpal::Error> {
        // On WASAPI, an input stream on a render endpoint is a loopback stream.
        let config = if loopback {
            device.default_output_config()?
        } else {
            device.default_input_config()?
        };
        let format = config.sample_format();
        let id = device.id()?;
        let (tx, packets) = mpsc::sync_channel(QUEUE);
        let failed = Arc::new(AtomicBool::new(false));
        let cfg = config.into();
        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::F64 => build::<f64>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::I16 => build::<i16>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::I24 => build::<cpal::I24>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::I32 => build::<i32>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::I8 => build::<i8>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::U8 => build::<u8>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::U16 => build::<u16>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::U24 => build::<cpal::U24>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::U32 => build::<u32>(&device, cfg, clock, tx, failed.clone()),
            SampleFormat::I64 => build::<i64>(&device, cfg, clock, tx, failed.clone()),
            _ => {
                return Err(cpal::Error::with_message(
                    cpal::ErrorKind::UnsupportedConfig,
                    "Unsupported meeting audio format",
                ))
            }
        }?;
        Ok(Self {
            stream,
            device: id,
            packets,
            failed,
        })
    }
}

fn build<T>(
    device: &Device,
    config: cpal::StreamConfig,
    clock: Clock,
    tx: SyncSender<Packet>,
    failed: Arc<AtomicBool>,
) -> Result<Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    let mut resampler = Resampler::new(config.sample_rate);
    let mut mono = Vec::new();
    let mut expected = None;
    let dropped = failed.clone();
    device.build_input_stream::<T, _, _>(
        config,
        move |data, info| {
            let Some(clock) = clock.get() else { return };
            let stamp = info.timestamp();
            let elapsed = clock.elapsed();
            let age = stamp.callback.duration_since(stamp.capture);
            let start = frames(elapsed.saturating_sub(age));
            if expected.is_some_and(|last: usize| last.abs_diff(start) > CLOCK_TOLERANCE) {
                resampler = Resampler::new(config.sample_rate);
            }
            mono.clear();
            mono.extend(
                data.chunks_exact(channels).map(|f| {
                    f.iter().map(|&s| s.to_sample::<f32>()).sum::<f32>() / channels as f32
                }),
            );
            let mut samples = Vec::new();
            resampler.push(&mono, &mut samples);
            expected = Some(start + samples.len());
            // A stalled disk can lose a packet, but it can't make the audio callback wait or grow an unbounded queue.
            if tx.try_send(Packet { start, samples }).is_err() {
                dropped.store(true, Ordering::Relaxed);
            }
        },
        move |_| failed.store(true, Ordering::Relaxed),
        None,
    )
}

struct Track {
    wave: Wave,
    input: Option<Input>,
    loopback: bool,
}

impl Track {
    fn device(&self, host: &cpal::Host) -> Option<Device> {
        if self.loopback {
            host.default_output_device()
        } else {
            host.default_input_device()
        }
    }

    fn refresh(&mut self, host: &cpal::Host, clock: &Clock) -> Result<bool, hound::Error> {
        let device = self.device(host);
        let id = device.as_ref().and_then(|d| d.id().ok());
        if self
            .input
            .as_ref()
            .is_some_and(|i| Some(&i.device) == id.as_ref() && !i.failed.load(Ordering::Relaxed))
        {
            return Ok(true);
        }
        self.disconnect(frames(clock.get().expect("recording clock started").elapsed()))?;
        self.input = device.and_then(|d| {
            let input = Input::open(d, clock.clone(), self.loopback).ok()?;
            input.stream.play().ok()?;
            Some(input)
        });
        Ok(self.input.is_some())
    }

    fn drain(&mut self, limit: usize) -> Result<(), hound::Error> {
        if let Some(input) = &self.input {
            for packet in input.packets.try_iter().take(QUEUE) {
                self.wave.append(packet, limit)?;
            }
        }
        Ok(())
    }

    fn disconnect(&mut self, limit: usize) -> Result<(), hound::Error> {
        if let Some(Input {
            stream, packets, ..
        }) = self.input.take()
        {
            drop(stream);
            for packet in packets.try_iter() {
                self.wave.append(packet, limit)?;
            }
        }
        Ok(())
    }

    fn finish(mut self, end: usize) -> Result<(), hound::Error> {
        self.disconnect(end)?;
        self.wave.pad_to(end)?;
        self.wave.writer.finalize()
    }
}

// A tool window stays visible when the tray or panel is hidden. It never takes keyboard focus.
struct Indicator(windows_sys::Win32::Foundation::HWND);

impl Indicator {
    fn show() -> std::io::Result<Self> {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let label: Vec<u16> = "● Recording meeting\0".encode_utf16().collect();
        unsafe {
            let mut work = RECT::default();
            if SystemParametersInfoW(SPI_GETWORKAREA, 0, (&mut work as *mut RECT).cast(), 0) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            const CENTER_TEXT: u32 = 0x0001 | 0x0200; // SS_CENTER | SS_CENTERIMAGE
            let width = 210;
            let h = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class.as_ptr(),
                label.as_ptr(),
                WS_POPUP | WS_BORDER | CENTER_TEXT,
                work.right - width - 16,
                work.top + 16,
                width,
                38,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            if h.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let indicator = Self(h);
            ShowWindow(h, SW_SHOWNOACTIVATE);
            if !indicator.visible() {
                return Err(std::io::Error::other(
                    "Recording indicator could not be shown",
                ));
            }
            Ok(indicator)
        }
    }

    fn visible(&self) -> bool {
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, self.0, 0, 0, PM_REMOVE) != 0 {
                DispatchMessageW(&msg);
            }
            IsWindowVisible(self.0) != 0
        }
    }
}

impl Drop for Indicator {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0);
        }
    }
}

#[derive(Default)]
pub struct Recorder(Option<Recording>);

struct Recording {
    folder: PathBuf,
    stop: Option<mpsc::Sender<Value>>,
    worker: JoinHandle<()>,
}

impl Recorder {
    pub fn command(&mut self, cmd: &Value) -> bool {
        let action = match cmd["cmd"].as_str() {
            Some(action @ ("meeting_start" | "meeting_stop" | "meeting_status")) => action,
            _ => return false,
        };
        if self.0.as_ref().is_some_and(|r| r.worker.is_finished()) {
            self.finish();
        }
        let id = &cmd["id"];
        match (action, &mut self.0) {
            ("meeting_start", None) => {
                let Some(folder) = cmd["folder"].as_str().map(PathBuf::from) else {
                    reply(id, false, "Missing meeting folder");
                    return true;
                };
                let (tx, rx) = mpsc::channel();
                let worker = {
                    let folder = folder.clone();
                    let id = id.clone();
                    thread::spawn(move || run(&folder, id, rx))
                };
                self.0 = Some(Recording {
                    folder,
                    stop: Some(tx),
                    worker,
                });
            }
            ("meeting_start", Some(_)) => reply(id, false, "A meeting is already recording"),
            ("meeting_stop", Some(recording)) => {
                if !recording
                    .stop
                    .take()
                    .is_some_and(|tx| tx.send(id.clone()).is_ok())
                {
                    reply(id, false, "The meeting is already stopping");
                }
            }
            ("meeting_stop", None) => reply(id, false, "No meeting is recording"),
            _ => emit(
                json!({ "type": "meeting", "state": "status", "id": id, "ok": true, "folder": self.0.as_ref().map(|r| &r.folder) }),
            ),
        }
        true
    }

    fn finish(&mut self) {
        if let Some(Recording { stop, worker, .. }) = self.0.take() {
            drop(stop);
            let _ = worker.join();
        }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.finish();
    }
}

fn reply(id: &Value, ok: bool, message: &str) {
    emit(json!({ "type": "meeting", "state": "reply", "id": id, "ok": ok, "error": message }));
}

fn run(folder: &Path, start_id: Value, stop: Receiver<Value>) {
    let mut id = start_id;
    if let Err(error) = record(folder, &mut id, stop) {
        emit(
            json!({ "type": "meeting", "state": "failed", "id": id, "folder": folder, "ok": false, "error": error.to_string() }),
        );
    }
}

fn record(
    folder: &Path,
    id: &mut Value,
    stop: Receiver<Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    let indicator = Indicator::show()?;
    let mut tracks = Vec::new();
    for (index, name) in TRACKS.iter().enumerate() {
        tracks.push(Track {
            wave: Wave::new(&folder.join(format!("{name}.wav")))?,
            input: None,
            loopback: index == 1,
        });
    }
    let host = cpal::default_host();
    let shared_clock = Clock::default();
    for track in &mut tracks {
        let device = track.device(&host).ok_or(if track.loopback {
            "No default playback device"
        } else {
            "No default microphone"
        })?;
        track.input = Some(Input::open(device, shared_clock.clone(), track.loopback)?);
    }
    // Open both endpoints before starting the shared clock and accepting samples.
    let clock = *shared_clock.get_or_init(Instant::now);
    for input in tracks.iter().filter_map(|track| track.input.as_ref()) {
        input.stream.play()?;
    }
    emit(
        json!({ "type": "meeting", "state": "recording", "id": id, "folder": folder, "ok": true }),
    );
    *id = Value::Null;
    let mut last_flush = clock;
    let mut last_refresh = clock;
    let mut missing = [false; TRACKS.len()];
    loop {
        let elapsed = clock.elapsed();
        match stop.recv_timeout(Duration::from_millis(20)) {
            Ok(stop_id) => {
                *id = stop_id;
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if !indicator.visible() {
            break;
        }
        for track in &mut tracks {
            track.drain(frames(clock.elapsed()))?;
        }
        if last_refresh.elapsed() >= Duration::from_millis(500) {
            for (index, track) in tracks.iter_mut().enumerate() {
                let offline = !track.refresh(&host, &shared_clock)?;
                if missing[index] != offline {
                    missing[index] = offline;
                    emit(
                        json!({ "type": "meeting", "state": "device", "folder": folder, "track": TRACKS[index], "offline": offline }),
                    );
                }
            }
            last_refresh = Instant::now();
        }
        if last_flush.elapsed() >= Duration::from_secs(2) {
            for track in &mut tracks {
                track
                    .wave
                    .pad_to(frames(elapsed.saturating_sub(Duration::from_millis(300))))?;
                track.wave.writer.flush()?;
            }
            last_flush = Instant::now();
        }
    }
    let end = frames(clock.elapsed());
    for track in tracks {
        track.finish(end)?;
    }
    drop(indicator);
    emit(json!({ "type": "meeting", "state": "stopped", "id": id, "folder": folder, "ok": true }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resamples_a_streamed_track_and_flushes_silent_gaps_to_wav() {
        let path =
            std::env::temp_dir().join(format!("roamies-track-test-{}.wav", std::process::id()));
        let mut wave = Wave::new(&path).unwrap();
        let mut resampler = Resampler::new(48_000);
        for n in 0..100 {
            let mut samples = Vec::new();
            resampler.push(&[0.5; 480], &mut samples);
            wave.append(
                Packet {
                    start: n * 160,
                    samples,
                },
                RATE_USIZE,
            )
            .unwrap();
        }
        assert_eq!(wave.written, RATE_USIZE);
        wave.writer.flush().unwrap();
        assert_eq!(hound::WavReader::open(&path).unwrap().duration(), RATE);
        wave.append(
            Packet {
                start: RATE_USIZE * 2,
                samples: vec![0.25; 160],
            },
            RATE_USIZE * 3,
        )
        .unwrap();
        wave.pad_to(RATE_USIZE * 3).unwrap();
        wave.writer.finalize().unwrap();
        let mut reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(
            reader.spec(),
            WavSpec {
                channels: 1,
                sample_rate: RATE,
                bits_per_sample: 16,
                sample_format: Int
            }
        );
        let samples: Vec<_> = reader.samples::<i16>().collect::<Result<_, _>>().unwrap();
        drop(reader);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(samples.len(), RATE_USIZE * 3);
        assert!(samples[..RATE_USIZE].iter().all(|&s| s == 16_383));
        assert!(samples[RATE_USIZE..RATE_USIZE * 2].iter().all(|&s| s == 0));
        assert_eq!(samples[RATE_USIZE * 2], 8191);
    }
}
