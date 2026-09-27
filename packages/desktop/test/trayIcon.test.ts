import { describe, expect, it, vi } from 'vitest';
import { TRAY_COLOR_PNG, TRAY_TEMPLATE_PNG, trayImage, type NativeImageFactory } from '../src/trayIcon.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function factory() {
  const image = { setTemplateImage: vi.fn() };
  const f = { createFromBuffer: vi.fn(() => image) } as unknown as NativeImageFactory & { createFromBuffer: ReturnType<typeof vi.fn> };
  return { f, image };
}

describe('trayImage', () => {
  it('두 아이콘 모두 32×32 PNG', () => {
    for (const b64 of [TRAY_TEMPLATE_PNG, TRAY_COLOR_PNG]) {
      const buf = Buffer.from(b64, 'base64');
      expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
      expect(buf.readUInt32BE(16)).toBe(32);
      expect(buf.readUInt32BE(20)).toBe(32);
    }
  });

  it('macOS 는 템플릿 이미지(2x), 그 외는 색 아이콘', () => {
    const mac = factory();
    trayImage('darwin', mac.f);
    expect(mac.f.createFromBuffer).toHaveBeenCalledWith(Buffer.from(TRAY_TEMPLATE_PNG, 'base64'), { scaleFactor: 2 });
    expect(mac.image.setTemplateImage).toHaveBeenCalledWith(true);
    const win = factory();
    trayImage('win32', win.f);
    expect(win.f.createFromBuffer).toHaveBeenCalledWith(Buffer.from(TRAY_COLOR_PNG, 'base64'), { scaleFactor: 2 });
    expect(win.image.setTemplateImage).not.toHaveBeenCalled();
  });
});
