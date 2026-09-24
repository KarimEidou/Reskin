//! The decisions behind the handoff state machine and the box's visibility,
//! apart from the windows they drive (so they are unit tested). `morph.rs`
//! and `actions.rs` act on them.

use reskin_core::model::CollapseThen;

/// Where the editor is in its life cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Closed,
    Opening,
    Open,
    Closing,
}

/// An open request, once no handoff runs any more (it waits for one in
/// progress), finds the editor open: its items join the editor's queue (or
/// it switches view) instead of a second handoff. Joining an editor that is
/// still opening could reach it before `Prepare`, which starts afresh, and
/// one that is closing would take them into hiding: either is waited for.
pub fn hands_over(phase: Phase) -> bool {
    phase == Phase::Open
}

/// The box may be on screen outside a handoff: the user has not hidden it
/// and no fullscreen app runs.
pub fn box_allowed(hidden_by_user: bool, hidden_for_fullscreen: bool) -> bool {
    !hidden_by_user && !hidden_for_fullscreen
}

/// What a box at rest needs: `Some(true)` show it, `Some(false)` hide it,
/// `None` it is as it should be.
pub fn rest_change(allowed: bool, visible: bool) -> Option<bool> {
    (allowed != visible).then_some(allowed)
}

/// What the hotkey or a tray click does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toggle {
    /// The editor is open: close it back into the box.
    CloseEditor,
    /// A handoff is running: it decides where the box goes.
    Nothing,
    /// A fullscreen app keeps the box hidden: open the editor instead.
    OpenEditor,
    /// Show or hide the box on the user's behalf (true = hide).
    SetHidden(bool),
}

pub fn toggle(phase: Phase, hidden_for_fullscreen: bool, box_visible: bool) -> Toggle {
    match phase {
        Phase::Open => Toggle::CloseEditor,
        Phase::Opening | Phase::Closing => Toggle::Nothing,
        Phase::Closed if hidden_for_fullscreen => Toggle::OpenEditor,
        Phase::Closed => Toggle::SetHidden(box_visible),
    }
}

/// What becomes of the editor window once a close put it at rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterClose {
    /// It stays, hidden, ready for the next open.
    Keep,
    /// Compatibility mode changed while it was open: the windows are rebuilt.
    Rebuild,
    /// Low-memory mode: it goes now.
    Destroy,
    /// Low-memory mode, closed by an apply (`fly` / `celebrate`): its page
    /// still settles that apply — its outcome, the design's autosave, which
    /// still holds the design being applied — so the editor goes once the
    /// page says it is done (`editor_close('applied')`).
    DestroyWhenSettled,
}

/// What a close that ended with `then` does with the editor (`rebuild`:
/// compatibility mode changed while it was open).
pub fn after_close(then: CollapseThen, low_memory: bool, rebuild: bool) -> AfterClose {
    if rebuild {
        AfterClose::Rebuild
    } else if !low_memory {
        AfterClose::Keep
    } else if then == CollapseThen::Hide {
        AfterClose::Destroy
    } else {
        AfterClose::DestroyWhenSettled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_open_hands_over_only_to_an_editor_that_is_open() {
        assert!(hands_over(Phase::Open));
        // A drop while the editor collapses must not go to the hiding
        // editor (the next open's Prepare would wipe it): it opens anew.
        assert!(!hands_over(Phase::Closing));
        // Nor may items reach an opening editor before its Prepare.
        assert!(!hands_over(Phase::Opening));
        assert!(!hands_over(Phase::Closed));
    }

    #[test]
    fn the_box_shows_only_when_neither_the_user_nor_a_fullscreen_app_hides_it() {
        assert!(box_allowed(false, false));
        assert!(!box_allowed(true, false));
        assert!(!box_allowed(false, true));
        assert!(!box_allowed(true, true));
    }

    #[test]
    fn a_box_at_rest_follows_what_is_allowed() {
        assert_eq!(rest_change(true, false), Some(true));
        assert_eq!(rest_change(false, true), Some(false));
        assert_eq!(rest_change(true, true), None);
        assert_eq!(rest_change(false, false), None);
    }

    #[test]
    fn the_hotkey_toggles_the_box_or_opens_the_editor_over_a_fullscreen_app() {
        assert_eq!(toggle(Phase::Open, false, false), Toggle::CloseEditor);
        assert_eq!(toggle(Phase::Open, true, false), Toggle::CloseEditor);
        assert_eq!(toggle(Phase::Opening, false, true), Toggle::Nothing);
        assert_eq!(toggle(Phase::Closing, false, true), Toggle::Nothing);
        assert_eq!(toggle(Phase::Closed, false, true), Toggle::SetHidden(true));
        assert_eq!(
            toggle(Phase::Closed, false, false),
            Toggle::SetHidden(false)
        );
        // Hidden for a fullscreen app: showing it would do nothing.
        assert_eq!(toggle(Phase::Closed, true, false), Toggle::OpenEditor);
    }

    #[test]
    fn low_memory_mode_destroys_the_editor_after_an_apply_only_once_its_page_is_done() {
        for then in [
            CollapseThen::Hide,
            CollapseThen::Fly,
            CollapseThen::Celebrate,
        ] {
            assert_eq!(after_close(then, false, false), AfterClose::Keep);
            assert_eq!(after_close(then, true, true), AfterClose::Rebuild);
            assert_eq!(after_close(then, false, true), AfterClose::Rebuild);
        }
        assert_eq!(
            after_close(CollapseThen::Hide, true, false),
            AfterClose::Destroy
        );
        assert_eq!(
            after_close(CollapseThen::Fly, true, false),
            AfterClose::DestroyWhenSettled
        );
        assert_eq!(
            after_close(CollapseThen::Celebrate, true, false),
            AfterClose::DestroyWhenSettled
        );
    }
}
