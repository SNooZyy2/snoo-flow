export function scrubPII(text: string, customPatterns?: Array<{ pattern: RegExp; replacement: string }>): string;
export function containsPII(text: string): boolean;
export function getRedactionStats(original: string, scrubbed: string): { redacted: boolean; originalLength: number; scrubbedLength: number; patterns: string[] };
export function scrubMemory(memory: { title: string; description: string; content: string; [key: string]: any }): { title: string; description: string; content: string; [key: string]: any };
