// src/api 的出口，要什么从这儿拿，别钻到具体文件里
// 内部再怎么拆（比如 dto 又分文件）都不该影响两端
// 依赖方向：这儿不碰 config / services / platform，纯契约

export * from "./envelope.ts";
export * from "./contract.ts";
export * from "./routes.ts";
export * from "./events.ts";
export * from "./dto/index.ts";
