/**
 * src/api 出口。对外仅暴露本文件，内部文件结构可变
 * 依赖方向：不引用 config / services / platform，属纯契约层
 */

export * from "./envelope.ts";
export * from "./contract.ts";
export * from "./routes.ts";
export * from "./events.ts";
export * from "./dto/index.ts";
