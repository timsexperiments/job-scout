export function normalize(value: string): string;
export function allowedPage(value: string): boolean;
export function answerFor(label: string, draft: { proposal: string; answers: { question: string; answer: string }[] }): string | null;
