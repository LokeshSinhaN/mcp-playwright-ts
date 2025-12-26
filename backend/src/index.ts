import dotenv from 'dotenv';
import { createServer } from './server';

dotenv.config();

const PORT = Number(process.env.PORT ?? 5000);
const CHROME_PATH = process.env.CHROMEDRIVER_PATH ?? 'C:\\hyprtask\\lib\\Chromium\\chromedriver.exe';

createServer(PORT, CHROME_PATH);
