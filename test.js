import { createConnection } from './dist/index.mjs';

// 模拟「其他项目用子进程 + stdio 协议」的启动方式：
createConnection()