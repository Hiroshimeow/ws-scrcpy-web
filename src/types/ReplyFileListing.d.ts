import type { FileStats } from './FileStats';
import type { Message } from './Message';

export interface ReplyFileListing extends Message {
    success: boolean;
    error?: string;
    list?: FileStats[];
}
