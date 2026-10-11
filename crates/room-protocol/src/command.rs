//! Things done *to* the room, as data.
//!
//! The shell observes state and issues commands; it never reaches into the
//! engine and changes something. That is what keeps React out of the artwork:
//! a component can dispatch [`EngineCommand::Reset`], and cannot set
//! `personality = 'overwhelmed'` because there is no way to say it.
//!
//! Commands are also the replay format's second half. An anonymous recording
//! that captures observations but not the operator pressing "forget everything"
//! cannot reproduce the evening it came from.

use serde::{Deserialize, Serialize};

use crate::config::EngineConfig;
use crate::geometry::Vec2;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "command")]
pub enum EngineCommand {
    /// Replace the engine's settings. Takes effect on the next step, never
    /// mid-step, so a step is always computed against one coherent config.
    Configure { config: EngineConfig },
    /// Forget everything: field, memories, day. The operator's hard reset.
    Reset,
    /// Move the installation to the next day. Memories keep their day, which is
    /// how "the room remembers last week" is distinguishable from "the room
    /// remembers this afternoon".
    AdvanceDay,
    /// Open the room. Plays the opening recall.
    Open,
    /// Close the room for the evening.
    Close,
    /// Make the room surface a memory now, at a place. The operator's way of
    /// showing a visitor what the piece does without waiting for chance.
    ForceRecall { at: Option<Vec2> },
    /// Add a presence by hand, for demonstration and for tests: the pointer in
    /// demo mode arrives this way rather than by pretending to be a camera.
    Nudge { at: Vec2 },
}

#[cfg(test)]
mod tests {
    use super::EngineCommand;
    use crate::geometry::Vec2;

    /// Commands go into replay files, so their names are a durable contract.
    #[test]
    fn commands_serialise_under_stable_names() {
        let json = serde_json::to_string(&EngineCommand::ForceRecall {
            at: Some(Vec2::new(0.5, 0.5)),
        })
        .expect("serialises");
        assert_eq!(json, r#"{"command":"forceRecall","at":{"x":0.5,"y":0.5}}"#);

        let reset = serde_json::to_string(&EngineCommand::Reset).expect("serialises");
        assert_eq!(reset, r#"{"command":"reset"}"#);
    }

    #[test]
    fn a_recorded_command_replays_into_the_same_command() {
        let original = EngineCommand::Nudge {
            at: Vec2::new(0.25, 0.75),
        };
        let json = serde_json::to_string(&original).expect("serialises");
        assert_eq!(
            serde_json::from_str::<EngineCommand>(&json).expect("parses"),
            original
        );
    }
}
