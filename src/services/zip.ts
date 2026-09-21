/*
 * 最小 zip 读取器。只做本地库需要的两件事：按中央目录顺序列出条目、把某一条解到磁盘。
 * 支持 stored(0) 与 deflate(8)，解压后校验 CRC32；中央目录与条目尺寸支持 Zip64。
 * 不处理加密、分卷与自解压头；条目数据用随机读，不把整个归档读进内存。
 */

import { open, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";

const inflate = promisify(inflateRaw);

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** 尾部里找 EOCD 的范围：注释最长 64KB，加上 EOCD 自身 22 字节 */
const TAIL_SCAN_BYTES = 0xffff + 22;
/** 一条中央目录记录的固定部分长度 */
const CENTRAL_FIXED_BYTES = 46;
const LOCAL_FIXED_BYTES = 30;

export interface ZipEntry {
    readonly name: string;
    /** 0 = 不压缩，8 = deflate */
    readonly method: number;
    readonly compressedSize: number;
    readonly size: number;
    readonly crc32: number;
    /** 条目头在文件中的位置，解压时据此找数据起点 */
    readonly headerOffset: number;
}

/** 目录分隔符统一为 /，便于按层级过滤 */
function normalizeName(name: string): string {
    return name.replaceAll("\\", "/");
}

/** 是否为目录条目。目录只占位，不参与解压 */
export function isDirectory(entry: ZipEntry): boolean {
    return entry.name.endsWith("/") || entry.name.endsWith("\\");
}

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead < length) {
        throw new Error(`归档读取不完整：位置 ${position} 需要 ${length} 字节，实际 ${bytesRead}`);
    }
    return buffer;
}

/** 从尾部找出中央目录的位置与条目数。返回的是相对整个文件的偏移 */
async function readDirectoryLocation(
    handle: FileHandle,
    fileSize: number,
): Promise<{ offset: number; size: number; count: number }> {
    const tailLength = Math.min(fileSize, TAIL_SCAN_BYTES);
    const tail = await readAt(handle, tailLength, fileSize - tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
        if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
            eocd = index;
            break;
        }
    }
    if (eocd === -1) {
        throw new Error("不是有效的 zip：找不到中央目录结束记录");
    }

    let count = tail.readUInt16LE(eocd + 10);
    let size = tail.readUInt32LE(eocd + 12);
    let offset = tail.readUInt32LE(eocd + 16);

    // 三项里出现 sentinel 就说明用的是 Zip64，真正的值在 Zip64 记录里
    const needsZip64 =
        count === 0xffff || size === 0xffffffff || offset === 0xffffffff || eocd < 20;
    if (!needsZip64) {
        return { offset, size, count };
    }
    if (eocd < 20) {
        throw new Error("不是有效的 zip：Zip64 定位记录缺失");
    }
    const locator = tail.subarray(eocd - 20, eocd);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
        throw new Error("不是有效的 zip：Zip64 定位记录缺失");
    }
    const zip64Offset = Number(locator.readBigUInt64LE(8));
    const record = await readAt(handle, 56, zip64Offset);
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
        throw new Error("不是有效的 zip：Zip64 结束记录缺失");
    }
    count = Number(record.readBigUInt64LE(32));
    size = Number(record.readBigUInt64LE(40));
    offset = Number(record.readBigUInt64LE(48));
    return { offset, size, count };
}

/** 条目里的 Zip64 附加字段：按 sentinel 出现顺序依次给出被省略的值 */
function parseZip64Extra(
    extra: Buffer,
    fields: { size: boolean; compressedSize: boolean; headerOffset: boolean },
): { size?: number; compressedSize?: number; headerOffset?: number } {
    let at = 0;
    while (at + 4 <= extra.length) {
        const id = extra.readUInt16LE(at);
        const length = extra.readUInt16LE(at + 2);
        const body = extra.subarray(at + 4, at + 4 + length);
        if (id === 0x0001) {
            let cursor = 0;
            const result: { size?: number; compressedSize?: number; headerOffset?: number } = {};
            if (fields.size && cursor + 8 <= body.length) {
                result.size = Number(body.readBigUInt64LE(cursor));
                cursor += 8;
            }
            if (fields.compressedSize && cursor + 8 <= body.length) {
                result.compressedSize = Number(body.readBigUInt64LE(cursor));
                cursor += 8;
            }
            if (fields.headerOffset && cursor + 8 <= body.length) {
                result.headerOffset = Number(body.readBigUInt64LE(cursor));
            }
            return result;
        }
        at += 4 + length;
    }
    return {};
}

/** 列出归档里的条目，顺序与归档内一致（也就是分页顺序） */
export async function readZipEntries(file: string): Promise<readonly ZipEntry[]> {
    const handle = await open(file, "r");
    try {
        const { size: fileSize } = await handle.stat();
        const location = await readDirectoryLocation(handle, fileSize);
        const directory = await readAt(handle, location.size, location.offset);
        const entries: ZipEntry[] = [];
        let at = 0;
        for (let index = 0; index < location.count; index += 1) {
            if (at + CENTRAL_FIXED_BYTES > directory.length) {
                throw new Error("zip 中央目录不完整");
            }
            if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
                throw new Error("zip 中央目录记录签名不对");
            }
            const method = directory.readUInt16LE(at + 10);
            const rawCrc = directory.readUInt32LE(at + 16);
            let compressedSize = directory.readUInt32LE(at + 20);
            let size = directory.readUInt32LE(at + 24);
            const nameLength = directory.readUInt16LE(at + 28);
            const extraLength = directory.readUInt16LE(at + 30);
            const commentLength = directory.readUInt16LE(at + 32);
            let headerOffset = directory.readUInt32LE(at + 42);

            const name = normalizeName(
                directory
                    .subarray(at + CENTRAL_FIXED_BYTES, at + CENTRAL_FIXED_BYTES + nameLength)
                    .toString("utf8"),
            );
            const extra = directory.subarray(
                at + CENTRAL_FIXED_BYTES + nameLength,
                at + CENTRAL_FIXED_BYTES + nameLength + extraLength,
            );

            const zip64 = parseZip64Extra(extra, {
                size: size === 0xffffffff,
                compressedSize: compressedSize === 0xffffffff,
                headerOffset: headerOffset === 0xffffffff,
            });
            if (zip64.size !== undefined) {
                size = zip64.size;
            }
            if (zip64.compressedSize !== undefined) {
                compressedSize = zip64.compressedSize;
            }
            if (zip64.headerOffset !== undefined) {
                headerOffset = zip64.headerOffset;
            }

            entries.push({ name, method, compressedSize, size, crc32: rawCrc, headerOffset });
            at += CENTRAL_FIXED_BYTES + nameLength + extraLength + commentLength;
        }
        return entries;
    } finally {
        await handle.close();
    }
}

/** CRC32 查表，首次使用时算出来 */
let crcTable: Uint32Array | null = null;

function crc32(buffer: Buffer): number {
    if (crcTable === null) {
        const table = new Uint32Array(256);
        for (let index = 0; index < 256; index += 1) {
            let value = index;
            for (let bit = 0; bit < 8; bit += 1) {
                value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
            }
            table[index] = value >>> 0;
        }
        crcTable = table;
    }
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 解出某一条到 targetPath
 * 压缩数据一次性读进内存：单个条目是图片，几 MB 量级，整体归档多大都不影响
 */
export async function extractEntry(
    file: string,
    entry: ZipEntry,
    targetPath: string,
): Promise<void> {
    const handle = await open(file, "r");
    try {
        const header = await readAt(handle, LOCAL_FIXED_BYTES, entry.headerOffset);
        if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
            throw new Error(`条目头签名不对：${entry.name}`);
        }
        const nameLength = header.readUInt16LE(26);
        const extraLength = header.readUInt16LE(28);
        const dataOffset = entry.headerOffset + LOCAL_FIXED_BYTES + nameLength + extraLength;

        const compressed = await readAt(handle, entry.compressedSize, dataOffset);
        let data: Buffer;
        if (entry.method === 0) {
            data = compressed;
        } else if (entry.method === 8) {
            data = await inflate(compressed);
        } else {
            throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
        }
        if (data.length !== entry.size) {
            throw new Error(`解压后大小不符：${entry.name}（${data.length} != ${entry.size}）`);
        }
        // 中央目录里的 CRC 是解压后的校验值，对不上说明归档损坏，此时报错而不落盘
        if (entry.crc32 !== 0 && crc32(data) !== entry.crc32) {
            throw new Error(`CRC 校验失败：${entry.name}`);
        }
        await writeFile(targetPath, data);
    } finally {
        await handle.close();
    }
}
