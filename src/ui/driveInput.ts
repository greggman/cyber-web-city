// Input for the user-flown car, which keeps flying forward on its own:
// keyboard (A/D or left/right to steer, W/S or up/down to climb and descend,
// E/Q to fly faster or slower) and, on touch screens, a virtual stick
// (steer + climb) with faster/slower buttons. Shown only while driving.
import type {DriveInput} from '../camera/drive';

const CSS = `
#ui-drive-stick, #ui-drive-speed {
  position: fixed; bottom: 24px; z-index: 10; touch-action: none;
  user-select: none; -webkit-user-select: none;
}
#ui-drive-stick {
  left: 24px; width: 132px; height: 132px; border-radius: 50%;
  background: rgba(8, 6, 18, 0.4); border: 1px solid rgba(120, 255, 255, 0.35);
}
#ui-drive-knob {
  position: absolute; left: 50%; top: 50%; width: 52px; height: 52px;
  margin: -26px 0 0 -26px; border-radius: 50%;
  background: rgba(120, 255, 255, 0.25); border: 1px solid #6ff;
  pointer-events: none;
}
/* (display: flex would otherwise override the hidden attribute) */
#ui-drive-stick[hidden], #ui-drive-speed[hidden] { display: none; }
#ui-drive-speed { right: 24px; display: flex; flex-direction: column; gap: 14px; }
#ui-drive-speed button {
  width: 58px; height: 58px; border-radius: 50%; font: 22px ui-monospace, monospace;
  color: #8ff; background: rgba(8, 6, 18, 0.45); border: 1px solid rgba(120, 255, 255, 0.35);
}
#ui-drive-speed button.down { border-color: #6ff; color: #cff; }
`;

export class DriveInputs {
  private keys = new Set<string>();
  private stick = {x: 0, y: 0};
  private speedTouch = 0;
  private touchUi: HTMLElement[] = [];
  private visible = false;

  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    window.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', e =>
      this.keys.delete(e.key.toLowerCase()),
    );
    window.addEventListener('blur', () => this.keys.clear());
    this.buildTouch();
  }

  private buildTouch() {
    const stick = document.createElement('div');
    stick.id = 'ui-drive-stick';
    const knob = document.createElement('div');
    knob.id = 'ui-drive-knob';
    stick.appendChild(knob);
    const R = 56;
    let id = -1;
    const move = (e: PointerEvent) => {
      const b = stick.getBoundingClientRect();
      let x = e.clientX - (b.left + b.width / 2);
      let y = e.clientY - (b.top + b.height / 2);
      const l = Math.hypot(x, y);
      if (l > R) {
        x *= R / l;
        y *= R / l;
      }
      knob.style.transform = `translate(${x}px, ${y}px)`;
      this.stick = {x: x / R, y: y / R};
    };
    const release = () => {
      id = -1;
      knob.style.transform = '';
      this.stick = {x: 0, y: 0};
    };
    stick.addEventListener('pointerdown', e => {
      e.stopPropagation();
      id = e.pointerId;
      stick.setPointerCapture(id);
      move(e);
    });
    stick.addEventListener('pointermove', e => {
      if (e.pointerId === id) move(e);
    });
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);

    const speed = document.createElement('div');
    speed.id = 'ui-drive-speed';
    for (const [label, dir] of [
      ['+', 1],
      ['−', -1],
    ] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-label', dir > 0 ? 'Faster' : 'Slower');
      const on = (e: PointerEvent) => {
        e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        b.classList.add('down');
        this.speedTouch = dir;
      };
      const off = () => {
        b.classList.remove('down');
        this.speedTouch = 0;
      };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      speed.appendChild(b);
    }
    this.touchUi = [stick, speed];
    for (const el of this.touchUi) {
      el.hidden = true;
      document.body.appendChild(el);
    }
  }

  /** Shows the touch controls while driving (on touch screens only). */
  setVisible(v: boolean) {
    this.visible = v;
    const touch = matchMedia('(pointer: coarse)').matches;
    for (const el of this.touchUi) el.hidden = !(v && touch);
  }

  read(): DriveInput {
    const k = (...names: string[]) => names.some(n => this.keys.has(n));
    let steer = (k('d', 'arrowright') ? 1 : 0) - (k('a', 'arrowleft') ? 1 : 0);
    let climb = (k('w', 'arrowup') ? 1 : 0) - (k('s', 'arrowdown') ? 1 : 0);
    let speed = (k('e', 'pageup') ? 1 : 0) - (k('q', 'pagedown') ? 1 : 0);
    if (this.visible) {
      steer += this.stick.x;
      climb += -this.stick.y;
      speed += this.speedTouch;
    }
    const c = (v: number) => Math.max(-1, Math.min(1, v));
    return {steer: c(steer), climb: c(climb), speed: c(speed)};
  }
}
