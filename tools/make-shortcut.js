'use strict';

/**
 * 直接生成 Windows 快捷方式（.lnk）二进制文件。
 *
 * 为什么不用 WScript.Shell：本环境的 PowerShell 安全策略拦截了 COM 实例化
 * （"COM object instantiation can run arbitrary code"）—— 这条限制是合理的，
 * 所以这里改为按 MS-SHLLINK 规范直接拼字节。
 *
 * 结构：ShellLinkHeader(76) + LinkInfo(变长) + StringData(Unicode 变长)
 * 因为桌面在 C: 而程序在 D:，跨盘符没法用相对路径，所以必须带 LinkInfo 写绝对路径。
 */

const fs = require('node:fs');

const TARGET = 'D:\\WordMaster\\start.bat';
const WORKDIR = 'D:\\WordMaster';
const ICON = 'D:\\WordMaster\\icon.ico';
const OUT = process.argv[2] || 'D:\\WordMaster\\_icon\\test.lnk';

/* ---------------- ShellLinkHeader (76 字节) ---------------- */

// CLSID 00021401-0000-0000-C000-000000000046
const LINK_CLSID = Buffer.from([
  0x01, 0x04, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]);

const FLAG_HAS_LINK_INFO = 0x00000002;
const FLAG_HAS_WORKING_DIR = 0x00000010;
const FLAG_HAS_ICON_LOCATION = 0x00000040;
const FLAG_IS_UNICODE = 0x00000080;

const header = Buffer.alloc(76);
header.writeUInt32LE(0x4C, 0);                      // HeaderSize = 76
LINK_CLSID.copy(header, 4);                         // LinkCLSID
header.writeUInt32LE(
  FLAG_HAS_LINK_INFO | FLAG_HAS_WORKING_DIR | FLAG_HAS_ICON_LOCATION | FLAG_IS_UNICODE,
  20
);
header.writeUInt32LE(0x20, 24);                     // FileAttributes = ARCHIVE
// 28/36/44 三个时间戳留 0（规范允许）
header.writeUInt32LE(0, 52);                        // FileSize
header.writeInt32LE(0, 56);                         // IconIndex
header.writeUInt32LE(1, 60);                        // ShowCommand = SW_SHOWNORMAL

/* ---------------- LinkInfo ---------------- */

const basePath = Buffer.from(TARGET + '\0', 'latin1');
const suffix = Buffer.from('\0', 'latin1');         // CommonPathSuffix 空
const volumeLabel = Buffer.from('\0', 'latin1');    // VolumeLabel 空

const HEADER_SIZE = 28;
const volumeIdSize = 16 + volumeLabel.length;
const volumeIdOffset = HEADER_SIZE;
const basePathOffset = volumeIdOffset + volumeIdSize;
const suffixOffset = basePathOffset + basePath.length;
const linkInfoSize = suffixOffset + suffix.length;

const linkInfo = Buffer.alloc(linkInfoSize);
linkInfo.writeUInt32LE(linkInfoSize, 0);
linkInfo.writeUInt32LE(HEADER_SIZE, 4);
linkInfo.writeUInt32LE(0x00000001, 8);              // VolumeIDAndLocalBasePath
linkInfo.writeUInt32LE(volumeIdOffset, 12);
linkInfo.writeUInt32LE(basePathOffset, 16);
linkInfo.writeUInt32LE(0, 20);                      // 无网络路径
linkInfo.writeUInt32LE(suffixOffset, 24);

linkInfo.writeUInt32LE(volumeIdSize, volumeIdOffset);
linkInfo.writeUInt32LE(3, volumeIdOffset + 4);      // DRIVE_FIXED
linkInfo.writeUInt32LE(0, volumeIdOffset + 8);      // 卷序列号留 0
linkInfo.writeUInt32LE(16, volumeIdOffset + 12);    // 卷标偏移（紧跟 16 字节头）
volumeLabel.copy(linkInfo, volumeIdOffset + 16);
basePath.copy(linkInfo, basePathOffset);
suffix.copy(linkInfo, suffixOffset);

/* ---------------- StringData（Unicode：2 字节字符数 + UTF-16，不补 \0） ---------------- */

function ustr(s) {
  const b = Buffer.alloc(2 + s.length * 2);
  b.writeUInt16LE(s.length, 0);
  b.write(s, 2, 'utf16le');
  return b;
}

const stringData = Buffer.concat([ustr(WORKDIR), ustr(ICON)]);

/* ---------------- 写出 ---------------- */

const buf = Buffer.concat([header, linkInfo, stringData]);
fs.mkdirSync(require('node:path').dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);

console.log('已写出:', OUT);
console.log('  总字节:', buf.length, '= 头 76 + LinkInfo', linkInfoSize, '+ StringData', stringData.length);
