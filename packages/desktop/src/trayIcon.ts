/**
 * 트레이 아이콘(32×32 PNG, 2x 로 16pt 표시). macOS 는 메뉴 막대 색에 맞춰지는 템플릿(검정+알파), 그 외는 파란색.
 */
import type { NativeImage } from 'electron';

export const TRAY_TEMPLATE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAeUlEQVR42u1X2xHAIAhz/6XTERSSkrQnd/xJiMpzrSt1wUZtjl8jAlKtzikSHUAZCRaEslf+YwtLHc0lPAwQgIqt/Owp007KHZ1TpBqYV1DcvmJ7CXyTwGgQjqehvRBFlGJ7M4pox/aBJGIkixhKI8byiMUkZjX7pzxTUHqUEMnSlQAAAABJRU5ErkJggg==';
export const TRAY_COLOR_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjElEQVR42u2Xyw2AQAhEacbKLN8ixgrMwoAwbjzMDcgj4WvHedmk7IsAWOg1AARVBoCkUgAoEgXABAz7RANl68UFkK7sSCyPU7bXQwBoAEAEgM7Ma8tkz7Tcox2TEYpalALIDJ4fYA+A1iJsb8PxQSQxiseXkcQ6Hj9IJE4yiaNU4iyXeExkXrM9v+MbnoFG7mtNHf0AAAAASUVORK5CYII=';

export interface NativeImageFactory {
  createFromBuffer(buffer: Buffer, options?: { scaleFactor?: number }): NativeImage;
}

export function trayImage(platform: NodeJS.Platform, factory: NativeImageFactory): NativeImage {
  const png = Buffer.from(platform === 'darwin' ? TRAY_TEMPLATE_PNG : TRAY_COLOR_PNG, 'base64');
  const image = factory.createFromBuffer(png, { scaleFactor: 2 });
  if (platform === 'darwin') image.setTemplateImage(true);
  return image;
}
