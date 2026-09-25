import { describe, expect, it } from 'vitest';
import { commitPendingWork, stage, type StageController } from './stage.svelte';

describe('commitPendingWork', () => {
  it('commits a pending tool session and leaves an idle engine alone', () => {
    let commits = 0;
    const pending = { hasPending: true, commitPending: () => commits++ };
    commitPendingWork(pending);
    expect(commits).toBe(1);
    const idle = { hasPending: false, commitPending: () => commits++ };
    commitPendingWork(idle);
    expect(commits).toBe(1);
  });
});

describe('stage', () => {
  function controller(log: string[]): StageController {
    return {
      fit: (a) => log.push(`fit ${a}`),
      actualSize: (a) => log.push(`actual ${a}`),
      zoomStep: (d, a) => log.push(`step ${d} ${a}`),
      setZoom: (z) => log.push(`zoom ${z}`),
      docRect: () => null,
      focus: () => log.push('focus'),
    };
  }

  it('forwards view actions to the mounted canvas stage and is inert without one', () => {
    const log: string[] = [];
    stage.fit();
    expect(stage.ready).toBe(false);
    expect(stage.docRect()).toBeNull();

    const detach = stage.attach(controller(log));
    expect(stage.ready).toBe(true);
    stage.fit(false);
    stage.actualSize();
    stage.zoomIn();
    stage.zoomOut(false);
    stage.setZoom(2);
    stage.focusCanvas();
    expect(log).toEqual(['fit false', 'actual true', 'step 1 true', 'step -1 false', 'zoom 2', 'focus']);

    detach();
    expect(stage.ready).toBe(false);
    stage.fit();
    expect(log).toHaveLength(6);
  });

  it('holds the canvas still through the mounted stage, and holds nothing without one', async () => {
    const log: string[] = [];
    const free = await stage.hold();
    free();
    const detach = stage.attach({
      ...controller(log),
      hold: async () => {
        log.push('hold');
        return () => log.push('let go');
      },
    });
    const letGo = await stage.hold();
    expect(log).toEqual(['hold']);
    letGo();
    expect(log).toEqual(['hold', 'let go']);
    detach();
    // A stage that cannot hold (no canvas to hold) holds nothing.
    const detachPlain = stage.attach(controller(log));
    (await stage.hold())();
    expect(log).toEqual(['hold', 'let go']);
    detachPlain();
  });

  it('a stale detach does not unhook a newer stage', () => {
    const first: string[] = [];
    const second: string[] = [];
    const detachFirst = stage.attach(controller(first));
    const detachSecond = stage.attach(controller(second));
    detachFirst();
    expect(stage.ready).toBe(true);
    stage.fit();
    expect(second).toEqual(['fit true']);
    detachSecond();
  });

  it('toggles keylines and the pixel grid', () => {
    const k = stage.keylines;
    stage.toggleKeylines();
    expect(stage.keylines).toBe(!k);
    stage.toggleKeylines();
    const g = stage.grid;
    stage.toggleGrid();
    expect(stage.grid).toBe(!g);
    stage.toggleGrid();
  });
});
