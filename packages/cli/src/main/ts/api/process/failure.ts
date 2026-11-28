const credentialAssignment = /\b[\w.-]*(?:password|passwd|secret|token|credential|authorization|api[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]/i;

export function toolFailure(message: string, stderr: Uint8Array): string {
  const lines = new TextDecoder().decode(stderr).split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-3);
  const tail = lines.map(line => {
    if (credentialAssignment.test(line)) return '[redacted tool output]';
    return line.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/:\/\/[^/\s]+@/g, '://[redacted]@')
      .replace(/[A-Za-z0-9_+=-]{32,}/g, '[redacted]').slice(0, 240);
  });
  return tail.length ? `${message}\n${tail.join('\n')}` : message;
}
