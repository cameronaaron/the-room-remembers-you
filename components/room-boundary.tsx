'use client';

import { Component, type ReactNode } from 'react';
import { type CrashDecision, decideCrashRecovery } from '@/lib/crash-recovery';

type Props = { children: ReactNode };

type State = {
  /** Bumped to rebuild the room from scratch. */
  generation: number;
  failed: boolean;
  decision: CrashDecision | null;
};

/**
 * Keeps a thrown error from becoming a blank gallery wall.
 *
 * Everything else in the installation is guarded — camera, microphone,
 * tracking, persistence, sound and now the GPU context all fail in isolation so
 * the rest continues. A render error was the one fault that took the whole
 * room, and it took it silently: React unmounts the tree, the projector paints
 * the page background, and in a dark room that is exactly what a room with
 * nothing to remember looks like.
 *
 * Room memory is unaffected by a remount. The field, the archive and the day's
 * provenance are in IndexedDB; only the live session — the swarm's particle
 * state, current tracks, and this session's audio, which was never persistable
 * — starts again.
 */
export class RoomBoundary extends Component<Props, State> {
  state: State = { generation: 0, failed: false, decision: null };
  private crashes: number[] = [];
  private timer = 0;

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    const { decision, history } = decideCrashRecovery(this.crashes, Date.now());
    this.crashes = history;
    this.setState({ decision });
    // The operator console is inside the tree that just died, so this is the
    // only place the fault can be recorded at the moment it happens.
    // decision.reason is one of decideCrashRecovery's fixed strings, never input.
    // nosemgrep: unsafe-formatstring
    console.error(`[room] ${decision.reason}`, error);
    if (!decision.remount) return;
    this.timer = window.setTimeout(() => {
      this.setState((previous) => ({
        generation: previous.generation + 1,
        failed: false,
        decision: null,
      }));
    }, decision.delayMs);
  }

  componentWillUnmount() {
    window.clearTimeout(this.timer);
  }

  render() {
    if (this.state.failed) {
      // Deliberately almost nothing: the room is dark, and a lit panel of
      // explanatory text is a floodlight thrown on the gallery wall. The
      // operator finds the detail in the console; the visitor should see the
      // room pause, not an apology.
      return (
        <output className="room-recovering" aria-live="polite">
          the room is remembering how to see
        </output>
      );
    }
    return <div key={this.state.generation} className="room-generation">{this.props.children}</div>;
  }
}
