import { Console } from "effect";

const colors = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function log(message: string) {
  return Console.log(message);
}

function logError(message: string) {
  return Console.error(message);
}

export function info(message: string) {
  return log(`${colors.blue}info${colors.reset} ${message}`);
}

export function success(message: string) {
  return log(`${colors.green}done${colors.reset} ${message}`);
}

export function warn(message: string) {
  return log(`${colors.yellow}warn${colors.reset} ${message}`);
}

export function error(message: string) {
  return logError(`${colors.red}error${colors.reset} ${message}`);
}

export function step(current: number, total: number, message: string) {
  const prefix = `${colors.cyan}[${current}/${total}]${colors.reset}`;
  return log(`${prefix} ${message}`);
}

export function dim(message: string): string {
  return `${colors.gray}${message}${colors.reset}`;
}

export function bold(message: string): string {
  return `${colors.bold}${message}${colors.reset}`;
}

export function green(message: string): string {
  return `${colors.green}${message}${colors.reset}`;
}
