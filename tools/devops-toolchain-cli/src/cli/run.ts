export function run<TOptions extends Record<string, unknown>>(handler: (options: TOptions) => Promise<number>) {
  return async (options: TOptions) => {
    try {
      process.exitCode = await handler(options);
    } catch (error) {
      console.error(`ERROR: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  };
}
