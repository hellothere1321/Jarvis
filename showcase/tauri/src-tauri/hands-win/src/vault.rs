use crate::{act, logic, uia, win};
use serde_json::{json, Value};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::System::Ole::{SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound};

fn runtime_id(el: &IUIAutomationElement) -> Option<Vec<i32>> {
    unsafe {
        let array = el.GetRuntimeId().ok()?;
        let read = || {
            let first = SafeArrayGetLBound(array, 1).ok()?;
            let last = SafeArrayGetUBound(array, 1).ok()?;
            if SafeArrayGetDim(array) != 1 || !(0..64).contains(&last.checked_sub(first)?) { return None; }
            (first..=last).map(|i| {
                let mut value = 0i32;
                SafeArrayGetElement(array, &i, (&mut value as *mut i32).cast()).ok()?;
                Some(value)
            }).collect()
        };
        let id = read();
        let _ = SafeArrayDestroy(array);
        id
    }
}

// Walk raw parents. Page content cannot supply the browser's own address bar.
fn document_chain(el: &IUIAutomationElement, root: &IUIAutomationElement) -> Option<Vec<(String, Vec<i32>)>> {
    unsafe {
        let walker = uia::uia().a.RawViewWalker().ok()?;
        let mut node = el.clone();
        let mut documents = Vec::new();
        for _ in 0..96 {
            if uia::same(&node, root) { return Some(documents); }
            if node.CurrentControlType().ok()?.0 == logic::CT_DOCUMENT {
                let url = node.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .and_then(|p| p.CurrentValue())
                    .or_else(|_| node.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId)
                        .and_then(|p| p.CurrentValue())).ok()?;
                documents.push((url.to_string(), runtime_id(&node)?));
            }
            node = walker.GetParentElement(&node).ok()?;
        }
        None
    }
}

fn target(password: bool) -> Option<(Value, IUIAutomationElement)> {
    let hwnd = win::front_hwnd();
    let w = win::windows().into_iter().find(|w| win::hwnd(w.id) == hwnd)?;
    if !logic::is_browser(&w.exe) || logic::hands_off(&w.exe).is_some() { return None; }
    unsafe {
        let a = &uia::uia().a;
        let root = a.ElementFromHandle(hwnd).ok()?;
        let (field, _, ct) = uia::focused()?;
        if ct != logic::CT_EDIT || field.CurrentIsPassword().ok()?.as_bool() != password { return None; }
        let docs = document_chain(&field, &root)?;
        // Never send credentials into an embedded document or browser chrome.
        if docs.len() != 1 { return None; }
        let (address, document) = &docs[0];
        let condition = a.CreatePropertyCondition(UIA_ControlTypePropertyId, &uia::i4(logic::CT_EDIT)).ok()?;
        let bar = root.FindFirst(TreeScope_Descendants, &condition).ok()?;
        if !document_chain(&bar, &root)?.is_empty() { return None; }
        let class = bar.CurrentClassName().ok()?.to_string();
        let id = bar.CurrentAutomationId().ok()?.to_string();
        if class != "OmniboxViewViews" && id != "urlbar-input" { return None; }
        let shown = bar.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok()?.CurrentValue().ok()?.to_string();
        if !logic::vault_address_matches(address, &shown) { return None; }
        if win::front_hwnd() != hwnd || !uia::is_focused(&field) { return None; }
        Some((json!({"ok":true,"id":w.id,"pid":w.pid,"exe":w.exe,"title":w.title,"url":address,"document":document}), field))
    }
}

pub fn front() -> Option<Value> { target(false).map(|t| t.0) }

pub fn fill() -> Option<()> {
    let m: Value = serde_json::from_reader(std::io::stdin().lock()).ok()?;
    let username = m["username"].as_str()?;
    let password = m["password"].as_str()?;
    let (now, field) = target(false)?;
    if now != m["expected"] || !uia::set_value(&field, username) { return None; }
    if target(false)?.0 != now || !uia::is_focused(&field) { return None; }
    act::press_key("tab");
    let (last, secret) = target(true)?;
    // Address this exact UIA element. Global keystrokes could land in another app after a focus change.
    if last != now || !uia::is_focused(&secret) || !unsafe { secret.CurrentIsPassword() }.ok()?.as_bool() { return None; }
    uia::set_value(&secret, password).then_some(())
}
