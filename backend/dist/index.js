"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const server_1 = require("./server");
dotenv_1.default.config();
const PORT = Number(process.env.PORT ?? 5000);
const CHROME_PATH = process.env.CHROMEDRIVER_PATH ?? 'C:\\hyprtask\\lib\\Chromium\\chromedriver.exe';
(0, server_1.createServer)(PORT, CHROME_PATH);
//# sourceMappingURL=index.js.map