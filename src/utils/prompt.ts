import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const answer = await rl.question(`${message} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}
