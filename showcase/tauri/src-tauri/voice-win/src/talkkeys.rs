// Right Ctrl and the Copilot key, each on its own: hold to talk (letting go sends), double-tap to type a question.
// A hook sees every press, so quick taps between the talk loop's polls aren't missed. The Copilot key sends
// Win+Shift+F23: its F23 is swallowed so Windows doesn't open Copilot, and a no-op key is sent while Win is still down
// so letting go of Win doesn't open Start (AutoHotkey's "menu mask key").
use std::cell::RefCell;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Which {
    RightCtrl,
    Copilot,
}

#[derive(Debug)]
pub enum Key {
    Press { which: Which, alone: bool },
    Release(Which),
    /// Another key went down while one of ours was held.
    Other,
}

#[derive(PartialEq, Debug)]
pub enum Action {
    None,
    /// Held long enough: start a push-to-talk take.
    Talk,
    /// Let go after talking: send what was said.
    Send,
    /// Another key during the take: it was a shortcut, drop it.
    Cancel,
    /// Two quick taps: open the field to type a question.
    Write,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum State {
    Up,
    Down { which: Which, since: f64 },
    Talking(Which),
    /// Part of a shortcut, or the second tap: nothing until it comes up.
    Spoiled,
}

/// Held this long it's a talk; let go sooner it's a tap.
const HOLD: f64 = 0.25;
/// A second tap that starts within this long of the first one ending makes a double tap.
const DOUBLE: f64 = 0.4;

pub struct Taps {
    state: State,
    last_tap: Option<(Which, f64)>,
}

impl Default for Taps {
    fn default() -> Self {
        Taps { state: State::Up, last_tap: None }
    }
}

impl Taps {
    pub fn key(&mut self, key: Key, now: f64) -> Action {
        match (key, self.state) {
            (Key::Press { which, alone }, State::Up) => {
                let double = self.last_tap.take().is_some_and(|(w, at)| w == which && now - at <= DOUBLE);
                self.state = if alone && !double { State::Down { which, since: now } } else { State::Spoiled };
                if alone && double { Action::Write } else { Action::None }
            }
            (Key::Release(w), State::Down { which, .. }) if w == which => {
                self.last_tap = Some((which, now));
                self.state = State::Up;
                Action::None
            }
            (Key::Release(w), State::Talking(which)) if w == which => {
                self.state = State::Up;
                Action::Send
            }
            (Key::Release(_), State::Spoiled) => {
                self.state = State::Up;
                Action::None
            }
            (Key::Other, State::Down { .. }) => {
                self.state = State::Spoiled;
                Action::None
            }
            (Key::Other, State::Talking(_)) => {
                self.state = State::Spoiled;
                Action::Cancel
            }
            _ => Action::None,
        }
    }

    /// Each loop beat: a key held past HOLD starts a take, when one can start now.
    pub fn tick(&mut self, now: f64, available: bool) -> Action {
        let State::Down { which, since } = self.state else { return Action::None };
        if now - since < HOLD {
            return Action::None;
        }
        self.state = if available { State::Talking(which) } else { State::Spoiled };
        if available { Action::Talk } else { Action::None }
    }
}

const VK_RCONTROL: u32 = 0xA3;
const VK_F23: u32 = 0x86;
const VK_LWIN: u32 = 0x5B;
const VK_LSHIFT: u32 = 0xA0;
/// Unassigned: Windows and apps ignore it.
const VK_MASK: u16 = 0xE8;

#[derive(Default)]
struct Hook {
    tx: Option<Sender<Key>>,
    held: Option<Which>,
}

thread_local! {
    static HOOK: RefCell<Hook> = RefCell::new(Hook::default());
}

fn send_mask_key() {
    let input = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_MASK, dwFlags: flags, ..Default::default() } },
    };
    let inputs = [input(0), input(KEYEVENTF_KEYUP)];
    // SAFETY: two initialized keyboard INPUTs that live through the call.
    unsafe { SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
}

/// True to swallow the key (the Copilot key's F23).
fn on_key(hook: &mut Hook, vk: u32, down: bool) -> bool {
    let Some(tx) = hook.tx.as_ref() else { return false };
    let which = match vk {
        VK_RCONTROL => Some(Which::RightCtrl),
        // F23 alone is a real (rare) key: only Win+F23 is the Copilot key.
        VK_F23 if hook.held == Some(Which::Copilot) || crate::keys::held().mods & crate::keys::COMMAND != 0 => Some(Which::Copilot),
        _ => None,
    };
    match (which, down, hook.held) {
        // Auto-repeat of the held key.
        (Some(w), true, Some(h)) if w == h => {}
        (Some(w), true, None) => {
            let f = crate::keys::held();
            let alone = match w {
                // The state of the key being pressed isn't updated yet when the hook runs.
                Which::RightCtrl => f.mods & !crate::keys::CONTROL == 0,
                Which::Copilot => f.mods & !(crate::keys::COMMAND | crate::keys::SHIFT) == 0,
            } && !f.altgr && !crate::keys::other_key_down();
            if w == Which::Copilot {
                send_mask_key();
            }
            hook.held = Some(w);
            let _ = tx.send(Key::Press { which: w, alone });
        }
        (Some(w), false, Some(h)) if w == h => {
            hook.held = None;
            let _ = tx.send(Key::Release(w));
        }
        // Win up before F23 up (some keyboards): the Copilot key is up.
        (None, false, Some(Which::Copilot)) if vk == VK_LWIN => {
            hook.held = None;
            let _ = tx.send(Key::Release(Which::Copilot));
        }
        // The Copilot key's own Win and Shift aren't other keys.
        (None, true, Some(Which::Copilot)) if vk == VK_LWIN || vk == VK_LSHIFT => {}
        (_, true, Some(_)) => {
            let _ = tx.send(Key::Other);
        }
        _ => {}
    }
    which == Some(Which::Copilot)
}

unsafe extern "system" fn keyboard_hook(code: i32, msg: WPARAM, param: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: WH_KEYBOARD_LL passes a KBDLLHOOKSTRUCT for HC_ACTION.
        let key = unsafe { &*(param as *const KBDLLHOOKSTRUCT) };
        if key.flags & LLKHF_INJECTED == 0 {
            let down = matches!(msg as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            if HOOK.with_borrow_mut(|hook| on_key(hook, key.vkCode, down)) {
                return 1;
            }
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
            HOOK.with_borrow_mut(|hook| hook.tx = Some(tx));
            // SAFETY: the callback is static and the message loop stays on this thread until the hook is removed.
            unsafe {
                let mut msg = MSG::default();
                PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), GetModuleHandleW(std::ptr::null()), 0);
                if hook.is_null() {
                    crate::log("couldn't watch Right Ctrl and the Copilot key");
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

#[cfg(test)]
mod tests {
    use super::*;

    const CTRL: Which = Which::RightCtrl;

    fn press(t: &mut Taps, which: Which, now: f64) -> Action {
        t.key(Key::Press { which, alone: true }, now)
    }

    #[test]
    fn holding_talks_and_letting_go_sends() {
        let mut t = Taps::default();
        assert_eq!(press(&mut t, Which::Copilot, 0.0), Action::None);
        assert_eq!(t.tick(0.2, true), Action::None);
        assert_eq!(t.tick(0.25, true), Action::Talk);
        assert_eq!(t.key(Key::Press { which: Which::Copilot, alone: true }, 0.5), Action::None, "auto-repeat");
        assert_eq!(t.key(Key::Release(Which::Copilot), 2.0), Action::Send);
    }

    #[test]
    fn two_quick_taps_open_the_typing_field_once() {
        let mut t = Taps::default();
        press(&mut t, CTRL, 0.0);
        assert_eq!(t.key(Key::Release(CTRL), 0.1), Action::None);
        assert_eq!(t.tick(0.2, true), Action::None);
        assert_eq!(press(&mut t, CTRL, 0.3), Action::Write);
        assert_eq!(t.tick(0.8, true), Action::None, "the second tap held on doesn't start a take");
        assert_eq!(t.key(Key::Release(CTRL), 0.9), Action::None);
        press(&mut t, CTRL, 1.0);
        t.key(Key::Release(CTRL), 1.1);
        assert_eq!(t.tick(1.2, true), Action::None);
    }

    #[test]
    fn slow_taps_and_different_keys_are_not_a_double_tap() {
        let mut t = Taps::default();
        press(&mut t, CTRL, 0.0);
        t.key(Key::Release(CTRL), 0.1);
        assert_eq!(press(&mut t, CTRL, 0.6), Action::None);
        t.key(Key::Release(CTRL), 0.7);
        assert_eq!(press(&mut t, Which::Copilot, 0.8), Action::None);
    }

    #[test]
    fn a_shortcut_is_not_a_talk() {
        let mut t = Taps::default();
        press(&mut t, CTRL, 0.0);
        assert_eq!(t.key(Key::Other, 0.1), Action::None); // Ctrl+C
        assert_eq!(t.tick(0.5, true), Action::None);
        assert_eq!(t.key(Key::Release(CTRL), 0.6), Action::None);
        assert_eq!(press(&mut t, CTRL, 0.7), Action::None, "a shortcut's Ctrl isn't the first tap");
        // Held a while before the key: the take had started and is dropped.
        let mut t = Taps::default();
        press(&mut t, CTRL, 0.0);
        assert_eq!(t.tick(0.3, true), Action::Talk);
        assert_eq!(t.key(Key::Other, 0.5), Action::Cancel);
        assert_eq!(t.key(Key::Release(CTRL), 0.6), Action::None);
        // Pressed with another modifier already down.
        let mut t = Taps::default();
        assert_eq!(t.key(Key::Press { which: CTRL, alone: false }, 0.0), Action::None);
        assert_eq!(t.tick(0.5, true), Action::None);
    }

    #[test]
    fn no_take_while_busy() {
        let mut t = Taps::default();
        press(&mut t, CTRL, 0.0);
        assert_eq!(t.tick(0.3, false), Action::None);
        assert_eq!(t.key(Key::Release(CTRL), 1.0), Action::None);
    }
}
