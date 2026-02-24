export const STEP_COLOR = '\x1b[38;5;45m'; // electric blue
export const COLOR_RESET = '\x1b[0m';

export function logStep(message: string): void {
  console.log(`${STEP_COLOR}${message}${COLOR_RESET}`);
}
