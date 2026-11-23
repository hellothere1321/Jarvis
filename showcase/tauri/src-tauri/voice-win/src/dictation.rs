// Watch Right Shift without swallowing keys. A hook catches taps between the talk loop's key polls.
use std::cell::RefCell;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VK_RSHIFT};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub enum Key {
    Press { alone: bool },
    Release,
    Other,
}

#[derive(Default, PartialEq, Debug)]
pub enum Hold {
    #[default]
    Up,
    Pending(f64),
    Blocked,
    Recording,
}

#[derive(PartialEq, Debug)]
pub enum Action {
    None,
    Finish,
    Cancel,
}

impl Hold {
    pub fn key(&mut self, key: Key, now: f64, available: bool) -> Action {
        let (next, action) = match (key, &*self) {
            (Key::Press { alone }, Self::Up) => (if alone && available { Self::Pending(now) } else { Self::Blocked }, Action::None),
            (Key::Other, Self::Pending(_)) => (Self::Blocked, Action::None),
            (Key::Other, Self::Recording) => (Self::Blocked, Action::Cancel),
            (Key::Release, Self::Recording) => (Self::Up, Action::Finish),
            (Key::Release, _) => (Self::Up, Action::None),
            _ => return Action::None,
        };
        *self = next;
        action
    }

    pub fn start(&mut self, now: f64, available: bool) -> bool {
        let Self::Pending(since) = *self else { return false };
        if !available {
            *self = Self::Blocked;
        } else if now >= since + 0.25 {
            *self = Self::Recording;
            return true;
        }
        false
    }
}

thread_local! {
    static HOOK: RefCell<Option<(Sender<Key>, bool)>> = const { RefCell::new(None) };
}

unsafe extern "system" fn keyboard_hook(code: i32, msg: WPARAM, param: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: WH_KEYBOARD_LL passes a KBDLLHOOKSTRUCT for HC_ACTION.
        let key = unsafe { &*(param as *const KBDLLHOOKSTRUCT) };
        if key.flags & LLKHF_INJECTED == 0 {
            HOOK.with_borrow_mut(|hook| {
                let Some((tx, held)) = hook else { return };
                match (key.vkCode == u32::from(VK_RSHIFT), msg as u32) {
                    (true, WM_KEYDOWN | WM_SYSKEYDOWN) if !*held => {
                        *held = true;
                        let _ = tx.send(Key::Press { alone: crate::keys::right_shift_is_alone() });
                    }
                    (true, WM_KEYUP | WM_SYSKEYUP) if *held => {
                        *held = false;
                        let _ = tx.send(Key::Release);
                    }
                    (false, WM_KEYDOWN | WM_SYSKEYDOWN) if *held => {
                        let _ = tx.send(Key::Other);
                    }
                    _ => {}
                }
            });
        }
    }
    // SAFETY: forward the original hook arguments unchanged; the hook handle is ignored.
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, msg, param) }
}

pub struct Keyboard {
    rx: Receiver<Key>,
    id: u32,
    thread: Option<JoinHandle<()>>,
}

impl Keyboard {
    pub fn watch() -> Option<Self> {
        let (ready, started) = mpsc::sync_channel(0);
        let (tx, rx) = mpsc::channel();
        let thread = thread::spawn(move || {
            HOOK.with_borrow_mut(|hook| *hook = Some((tx, false)));
            // SAFETY: the callback is static and the message loop stays on this thread until the hook is removed.
            unsafe {
                let mut msg = MSG::default();
                PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), GetModuleHandleW(std::ptr::null()), 0);
                if hook.is_null() {
                    crate::log("couldn't watch Right Shift for dictation");
                    return;
                }
                if ready.send(GetCurrentThreadId()).is_ok() {
                    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
                }
                UnhookWindowsHookEx(hook);
            }
        });
        let id = started.recv().ok()?;
        Some(Self { rx, id, thread: Some(thread) })
    }

    pub fn next(&self) -> Option<Key> {
        self.rx.try_recv().ok()
    }
}

impl Drop for Keyboard {
    fn drop(&mut self) {
        // SAFETY: watch created the thread's message queue before handing us its id.
        unsafe { PostThreadMessageW(self.id, WM_QUIT, 0, 0) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn filler(word: &str) -> bool {
    let word = word.trim_end_matches([',', '.']).to_ascii_lowercase();
    ["um", "uh", "uhm", "erm", "hmm", "mhm"].iter().any(|prefix| {
        let last = prefix.as_bytes()[prefix.len() - 1];
        word.strip_prefix(prefix).is_some_and(|rest| rest.bytes().all(|b| b == last))
    })
}

pub fn format(text: &str) -> String {
    let mut clean = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(['[', '(']) {
        let Some(end) = rest[start + 1..].find([']', ')']) else { break };
        clean.push_str(&rest[..start]);
        rest = &rest[start + end + 2..];
    }
    clean.push_str(rest);
    let clean = clean.trim();
    let cap = clean.starts_with(char::is_uppercase);
    if ["you", "thanks for watching", "thank you for watching", "please subscribe", "bye", "bye bye"]
        .iter().any(|phrase| clean.trim_matches([' ', '.', '!', '?', ',']).eq_ignore_ascii_case(phrase))
    {
        return String::new();
    }
    let mut words = clean.split_whitespace().filter(|word| !filler(word)).peekable();
    let mut out = String::new();
    while let Some(word) = words.next() {
        if word.eq_ignore_ascii_case("new") {
            let breaks = words.peek().and_then(|w| {
                let w = w.trim_end_matches(['.', ',', '!', '?']);
                if w.eq_ignore_ascii_case("line") {
                    Some("\n")
                } else if w.eq_ignore_ascii_case("paragraph") {
                    Some("\n\n")
                } else {
                    None
                }
            });
            if let Some(breaks) = breaks {
                words.next();
                out.push_str(breaks);
                continue;
            }
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push(' ');
        }
        out.push_str(word);
    }
    if !out.contains('\n') && out.chars().all(|c| c.is_whitespace() || c.is_ascii_punctuation() || c == '…') {
        return String::new();
    }
    if let Some(c) = out.chars().next().filter(|c| cap && c.is_lowercase()) {
        out.replace_range(..c.len_utf8(), &c.to_uppercase().to_string());
    }
    if !out.ends_with('\n') {
        out.push(' ');
    }
    out
}

fn inputs(text: &str) -> Vec<INPUT> {
    // Newlines are text too. A real Enter press could submit a message.
    text.encode_utf16().flat_map(|unit| {
        [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP].map(|flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wScan: unit, dwFlags: flags, ..Default::default() } },
        })
    }).collect()
}

pub fn type_text(text: &str) -> bool {
    let inputs = inputs(text);
    let len = inputs.len() as u32;
    // SAFETY: inputs is a batch of initialized keyboard INPUTs and lives through the call.
    let sent = unsafe { SendInput(len, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    sent == len
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(hold: &mut Hold, alone: bool, available: bool) {
        assert_eq!(hold.key(Key::Press { alone }, 0.0, available), Action::None);
    }

    #[test]
    fn a_hold_starts_after_250_ms_and_release_finishes() {
        let mut hold = Hold::default();
        press(&mut hold, true, true);
        assert!(!hold.start(0.249, true));
        assert!(hold.start(0.250, true));
        assert_eq!(hold.key(Key::Release, 0.5, false), Action::Finish);
    }

    #[test]
    fn capitals_and_already_held_keys_do_not_start_dictation() {
        let mut hold = Hold::default();
        press(&mut hold, true, true);
        assert_eq!(hold.key(Key::Other, 0.1, true), Action::None);
        assert!(!hold.start(0.5, true));
        assert_eq!(hold.key(Key::Release, 0.6, true), Action::None);
        press(&mut hold, false, true);
        assert!(!hold.start(1.0, true));
    }

    #[test]
    fn a_tap_does_nothing() {
        let mut hold = Hold::default();
        press(&mut hold, true, true);
        assert_eq!(hold.key(Key::Release, 0.1, true), Action::None);
        assert!(!hold.start(0.5, true));
    }

    #[test]
    fn a_key_during_a_take_cancels_it() {
        let mut hold = Hold::default();
        press(&mut hold, true, true);
        assert!(hold.start(0.25, true));
        assert_eq!(hold.key(Key::Other, 0.4, false), Action::Cancel);
        assert!(!hold.start(0.5, true));
        assert_eq!(hold.key(Key::Release, 0.6, true), Action::None);
    }

    #[test]
    fn a_talk_take_ignores_right_shift_even_if_talk_ends_while_held() {
        let mut hold = Hold::default();
        press(&mut hold, true, false);
        assert!(!hold.start(0.5, true));
        assert_eq!(hold.key(Key::Release, 0.6, true), Action::None);
    }

    #[test]
    fn formatting_keeps_casing_and_adds_spaces_or_spoken_breaks() {
        assert_eq!(format("  Um, hello World!  "), "Hello World! ");
        assert_eq!(format("hello new line WORLD new paragraph. Next"), "hello\nWORLD\n\nNext ");
        assert_eq!(format("Hello. New line."), "Hello.\n");
        assert_eq!(format("[noise] (cough) um, ..."), "");
        assert_eq!(format("Thanks for watching!"), "");
        assert_eq!(format("😀"), "😀 ");
    }

    #[test]
    fn the_input_batch_pairs_each_utf16_unit_and_keeps_emoji_together() {
        let batch = inputs("A😀\n");
        let keys: Vec<_> = batch.iter().map(|input| {
            assert_eq!(input.r#type, INPUT_KEYBOARD);
            // SAFETY: inputs initialized the keyboard member for every entry.
            let key = unsafe { input.Anonymous.ki };
            (key.wVk, key.wScan, key.dwFlags)
        }).collect();
        let u = KEYEVENTF_UNICODE;
        let up = KEYEVENTF_KEYUP;
        assert_eq!(keys, [(0, 0x41, u), (0, 0x41, u | up), (0, 0xD83D, u), (0, 0xD83D, u | up), (0, 0xDE00, u), (0, 0xDE00, u | up), (0, 0x0A, u), (0, 0x0A, u | up)]);
    }
}
