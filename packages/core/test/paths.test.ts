import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedRoot, isWithin, resolveAllowedPath, unsafeAllowedDirReason } from '../src/paths.js';
import { ToolError } from '../src/errors.js';

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aeyes-paths-')));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await mkdir(allowed);
  await mkdir(outside);
  await writeFile(path.join(allowed, 'a.txt'), 'a');
  await writeFile(path.join(outside, 'secret.txt'), 's');
  return { root, allowed, outside };
}

describe('isWithin', () => {
  it('자기 자신과 하위는 true, 형제·상위는 false', () => {
    expect(isWithin('/a/b', '/a/b', 'linux')).toBe(true);
    expect(isWithin('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(isWithin('/a/bc', '/a/b', 'linux')).toBe(false);
    expect(isWithin('/a', '/a/b', 'linux')).toBe(false);
  });
  it('이름이 ..으로 시작하는 하위 폴더는 하위로 본다', () => {
    expect(isWithin('/a/b/..hidden/x', '/a/b', 'linux')).toBe(true);
  });
  it('case-insensitive on darwin', () => {
    expect(isWithin('/Users/A/Documents/AeyeStudio/x', '/users/a/documents/aeyestudio', 'darwin')).toBe(true);
    expect(isWithin('/Users/A/Documents/AeyeStudio/x', '/users/a/documents/aeyestudio', 'linux')).toBe(false);
  });
  it('Windows 는 드라이브·대소문자를 무시하고 다른 드라이브·UNC 는 밖', () => {
    expect(isWithin('C:\\Users\\A\\Docs\\x.txt', 'c:\\users\\a\\docs', 'win32')).toBe(true);
    expect(isWithin('D:\\Users\\A\\Docs\\x.txt', 'C:\\Users\\A\\Docs', 'win32')).toBe(false);
    expect(isWithin('\\\\server\\share\\x', 'C:\\Users\\A\\Docs', 'win32')).toBe(false);
  });
});

describe('resolveAllowedPath', () => {
  it('상대 경로는 첫 허용 폴더 기준', async () => {
    const { allowed } = await sandbox();
    expect(await resolveAllowedPath('a.txt', [allowed])).toBe(path.join(allowed, 'a.txt'));
  });

  it('../ 로 빠져나가면 path_not_allowed', async () => {
    const { allowed } = await sandbox();
    await expect(resolveAllowedPath('../outside/secret.txt', [allowed])).rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  it('절대 경로가 허용 폴더 밖이면 거부', async () => {
    const { allowed, outside } = await sandbox();
    await expect(resolveAllowedPath(path.join(outside, 'secret.txt'), [allowed])).rejects.toBeInstanceOf(ToolError);
  });

  it.skipIf(process.platform === 'win32')('밖을 가리키는 심볼릭 링크는 거부', async () => {
    const { allowed, outside } = await sandbox();
    await symlink(outside, path.join(allowed, 'link'));
    await expect(resolveAllowedPath('link/secret.txt', [allowed])).rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  it.skipIf(process.platform === 'win32')('밖을 가리키는 끊어진 심볼릭 링크(잎)는 path_not_allowed', async () => {
    const { allowed, outside } = await sandbox();
    await symlink(path.join(outside, 'planted.txt'), path.join(allowed, 'dangling.txt'));
    await expect(resolveAllowedPath('dangling.txt', [allowed])).rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  it.skipIf(process.platform === 'win32')('중간 경로가 끊어진 심볼릭 링크여도 path_not_allowed', async () => {
    const { allowed, outside } = await sandbox();
    await symlink(path.join(outside, 'nodir'), path.join(allowed, 'dlink'));
    await expect(resolveAllowedPath('dlink/new/file.txt', [allowed])).rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  it('없는 파일은 mustExist 면 not_found, 아니면 가장 가까운 상위 기준으로 해석', async () => {
    const { allowed } = await sandbox();
    await expect(resolveAllowedPath('nope.txt', [allowed], { mustExist: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(await resolveAllowedPath('new/dir/file.txt', [allowed])).toBe(path.join(allowed, 'new', 'dir', 'file.txt'));
  });

  it('빈 문자열·NUL 문자는 invalid_argument', async () => {
    const { allowed } = await sandbox();
    await expect(resolveAllowedPath('', [allowed])).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(resolveAllowedPath('a\0b', [allowed])).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('완전히 없는 루트 경로는 not_found 아니라 path_not_allowed 로 거부', async () => {
    const { allowed } = await sandbox();
    // realpathFn 이 항상 ENOENT 를 던지도록 하여 존재하지 않는 루트 경로를 시뮬레이션
    const mockRealpath = async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    // mustExist: true 일 때 path_not_allowed 로 거부 (not_found 아님)
    await expect(
      resolveAllowedPath('/nonexistent-root/path/to/file', [allowed], {
        mustExist: true,
        realpathFn: mockRealpath
      })
    ).rejects.toMatchObject({ code: 'path_not_allowed' });
    // mustExist: false 일 때도 path_not_allowed 로 거부
    await expect(
      resolveAllowedPath('/nonexistent-root/path/to/file', [allowed], {
        realpathFn: mockRealpath
      })
    ).rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  it('isAllowedRoot 는 허용 폴더 자체만 true', async () => {
    const { allowed } = await sandbox();
    expect(await isAllowedRoot(allowed, [allowed])).toBe(true);
    expect(await isAllowedRoot(path.join(allowed, 'a.txt'), [allowed])).toBe(false);
  });
});

describe('설정 폴더 제외(deniedDirs)', () => {
  it('허용 폴더 안이라도 deniedDirs 안이면 path_not_allowed', async () => {
    const { allowed } = await sandbox();
    const cfg = path.join(allowed, '.aeyes-agent');
    await mkdir(cfg);
    await writeFile(path.join(cfg, 'config.json'), '{}');
    await expect(resolveAllowedPath('.aeyes-agent/config.json', [allowed], { deniedDirs: [cfg] })).rejects.toMatchObject({ code: 'path_not_allowed' });
    await expect(resolveAllowedPath('.aeyes-agent/new.txt', [allowed], { deniedDirs: [cfg] })).rejects.toMatchObject({ code: 'path_not_allowed' });
    // 대소문자를 구분하는 Linux 에서는 .AEYES-AGENT 가 설정 폴더와 다른 (아직 없는) 경로라 허용된다.
    if (process.platform === 'linux') {
      expect(await resolveAllowedPath('.AEYES-AGENT', [allowed], { deniedDirs: [cfg] })).toBe(path.join(allowed, '.AEYES-AGENT'));
    } else {
      await expect(resolveAllowedPath('.AEYES-AGENT', [allowed], { deniedDirs: [cfg] })).rejects.toMatchObject({ code: 'path_not_allowed' });
    }
    expect(await resolveAllowedPath('a.txt', [allowed], { deniedDirs: [cfg] })).toBe(path.join(allowed, 'a.txt'));
  });
});

describe('unsafeAllowedDirReason', () => {
  const posix = { home: '/Users/a', configDir: '/Users/a/.aeyes-agent', platform: 'darwin' as const };
  const win = { home: 'C:\\Users\\a', configDir: 'C:\\Users\\a\\AppData\\Roaming\\aeyes-agent', platform: 'win32' as const };
  it('루트·홈·홈 상위·설정 폴더 포함은 거부', () => {
    for (const d of ['/', '/Users', '/Users/a', '/USERS/A']) expect(unsafeAllowedDirReason(d, posix), d).not.toBeNull();
    for (const d of ['C:\\', 'D:\\', 'C:\\Users', 'c:\\users\\A', '\\\\server\\share\\']) expect(unsafeAllowedDirReason(d, win), d).not.toBeNull();
    expect(unsafeAllowedDirReason('C:\\Users\\a\\AppData', win)).not.toBeNull();
  });
  it('홈 아래의 일반 폴더는 허용', () => {
    expect(unsafeAllowedDirReason('/Users/a/Documents/AeyeStudio', posix)).toBeNull();
    expect(unsafeAllowedDirReason('/Volumes/Data/shop', posix)).toBeNull();
    expect(unsafeAllowedDirReason('C:\\Users\\a\\Documents\\AeyeStudio', win)).toBeNull();
  });
});
