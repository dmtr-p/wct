export async function confirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} [y/N] `);

  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }

  return false;
}
