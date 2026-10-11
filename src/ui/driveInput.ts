// Input for the user-flown car: keyboard (WASD / arrows, E/Q to climb and
// descend) and, on touch screens, a virtual stick (steer + throttle) with
// climb/descend buttons. Shown only while driving.
import type {DriveInput} from '../camera/drive';

const CSS = `
#ui-drive-stick, #ui-drive-climb {
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
#ui-drive-climb { right: 24px; display: flex; flex-direction: column; gap: 14px; }
#ui-drive-climb button {
  width: 58px; height: 58px; border-radius: 50%; font: 22px ui-monospace, monospace;
  color: #8ff; background: rgba(8, 6, 18, 0.45); border: 1px solid rgba(120, 255, 255, 0.35);
}
#ui-drive-climb button.down { border-color: #6ff; color: #cff; }
`;

export class DriveInputs {
  private keys = new Set<string>();
  private stick = {x: 0, y: 0};
  private climbTouch = 0;
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

    const climb = document.createElement('div');
    climb.id = 'ui-drive-climb';
    for (const [label, dir] of [
      ['▲', 1],
      ['▼', -1],
    ] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-label', dir > 0 ? 'Climb' : 'Descend');
      const on = (e: PointerEvent) => {
        e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        b.classList.add('down');
        this.climbTouch = dir;
      };
      const off = () => {
        b.classList.remove('down');
        this.climbTouch = 0;
      };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      climb.appendChild(b);
    }
    this.touchUi = [stick, climb];
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
    let throttle = (k('w', 'arrowup') ? 1 : 0) - (k('s', 'arrowdown') ? 1 : 0);
    let steer = (k('d', 'arrowright') ? 1 : 0) - (k('a', 'arrowleft') ? 1 : 0);
    let climb = (k('e', 'pageup') ? 1 : 0) - (k('q', 'pagedown') ? 1 : 0);
    if (this.visible) {
      throttle += -this.stick.y;
      steer += this.stick.x;
      climb += this.climbTouch;
    }
    const c = (v: number) => Math.max(-1, Math.min(1, v));
    return {throttle: c(throttle), steer: c(steer), climb: c(climb)};
  }
}
