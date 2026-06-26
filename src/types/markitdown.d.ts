declare module '@mote-software/markitdown' {
  export function getBinaryPath(): string;
  export function runMarkitdown(input: string): string;
}

// Kept for legacy imports; the project no longer depends on this package.
// We shell out to the official Microsoft MarkItDown CLI installed in the Docker image.