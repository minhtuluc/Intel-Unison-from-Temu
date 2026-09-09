import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('WakeLock and Tab Guard Logic (Unit)', () => {
  describe('Tab Guard beforeunload handler', () => {
    function handleBeforeUnload(event, activeCount) {
      if (activeCount > 0) {
        event.preventDefault();
        event.returnValue = 'Transfer in progress. Are you sure you want to leave?';
        return event.returnValue;
      }
      return undefined;
    }

    it('should block navigation when transfers are active', () => {
      let defaultPrevented = false;
      const event = {
        preventDefault: () => {
          defaultPrevented = true;
        },
        returnValue: '',
      };

      const result = handleBeforeUnload(event, 2);
      assert.ok(defaultPrevented, 'preventDefault called');
      assert.ok(event.returnValue.includes('Transfer in progress'));
      assert.ok(result?.includes('Transfer in progress'));
    });

    it('should allow navigation when no transfers are active', () => {
      let defaultPrevented = false;
      const event = {
        preventDefault: () => {
          defaultPrevented = true;
        },
        returnValue: '',
      };

      const result = handleBeforeUnload(event, 0);
      assert.equal(defaultPrevented, false, 'preventDefault NOT called');
      assert.equal(event.returnValue, '');
      assert.equal(result, undefined);
    });
  });

  describe('Screen WakeLock Controller Logic', () => {
    class MockWakeLockController {
      constructor() {
        this.sentinel = null;
        this.acquireCalls = 0;
        this.releaseCalls = 0;
      }

      async acquire() {
        if (!this.sentinel) {
          this.acquireCalls++;
          this.sentinel = {
            released: false,
            release: async () => {
              this.releaseCalls++;
              this.sentinel = null;
            },
          };
        }
      }

      async release() {
        if (this.sentinel) {
          await this.sentinel.release();
        }
      }

      update(activeCount) {
        if (activeCount > 0) {
          return this.acquire();
        } else {
          return this.release();
        }
      }
    }

    it('should acquire lock when active transfers > 0', async () => {
      const controller = new MockWakeLockController();
      await controller.update(1);

      assert.equal(controller.acquireCalls, 1);
      assert.ok(controller.sentinel !== null);

      // Subsequent update with active transfers should not re-request if already held
      await controller.update(2);
      assert.equal(controller.acquireCalls, 1);
    });

    it('should release lock when active transfers drop to 0', async () => {
      const controller = new MockWakeLockController();
      await controller.update(1);
      assert.ok(controller.sentinel !== null);

      await controller.update(0);
      assert.equal(controller.releaseCalls, 1);
      assert.equal(controller.sentinel, null);
    });
  });

  describe('Platform & Standalone Detection Logic', () => {
    function isIos(ua, platform = '', maxTouchPoints = 0) {
      const u = ua.toLowerCase();
      return /iphone|ipad|ipod/.test(u) || (platform === 'MacIntel' && maxTouchPoints > 1);
    }

    function isStandalone(navigatorStandalone, matchMediaStandalone) {
      return Boolean(navigatorStandalone || matchMediaStandalone);
    }

    it('should correctly identify iOS user agents', () => {
      const iPhoneUa =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
      const iPadUa =
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
      const macTouchUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
      const androidUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36';
      const windowsUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

      assert.equal(isIos(iPhoneUa), true, 'iPhone is iOS');
      assert.equal(isIos(iPadUa), true, 'iPad is iOS');
      assert.equal(isIos(macTouchUa, 'MacIntel', 5), true, 'iPadOS desktop mode is iOS');
      assert.equal(isIos(macTouchUa, 'MacIntel', 0), false, 'Normal Mac desktop is not iOS');
      assert.equal(isIos(androidUa), false, 'Android is not iOS');
      assert.equal(isIos(windowsUa), false, 'Windows is not iOS');
    });

    it('should correctly detect standalone display mode', () => {
      assert.equal(isStandalone(true, false), true, 'iOS navigator.standalone = true');
      assert.equal(isStandalone(false, true), true, 'matchMedia standalone = true');
      assert.equal(isStandalone(false, false), false, 'Browser tab mode = false');
    });
  });
});
