export interface ClassString {
  file: string;
  line: number;
  cls: string;
}

function skipTemplate(src: string, i: number): number {
  let p = i + 1;
  while (p < src.length) {
    const c = src[p];
    if (c === "\\") p += 2;
    else if (c === "`") return p + 1;
    else if (c === "$" && src[p + 1] === "{") p = skipBraces(src, p + 1);
    else p++;
  }
  return src.length;
}

function skipQuoted(src: string, i: number): number {
  const q = src[i];
  let p = i + 1;
  while (p < src.length && src[p] !== "\n") {
    if (src[p] === "\\") p += 2;
    else if (src[p] === q) return p + 1;
    else p++;
  }
  return i + 1;
}

function skipBraces(src: string, i: number): number {
  let depth = 0;
  let p = i;
  while (p < src.length) {
    const c = src[p];
    if (c === "{") {
      depth++;
      p++;
    } else if (c === "}") {
      depth--;
      p++;
      if (depth === 0) return p;
    } else if (c === "`") p = skipTemplate(src, p);
    else if (c === '"' || c === "'") p = skipQuoted(src, p);
    else p++;
  }
  return src.length;
}

export function extractClassStrings(file: string, source: string): ClassString[] {
  const out: ClassString[] = [];
  const lineAt = (idx: number) => source.slice(0, idx).split("\n").length;
  const push = (idx: number, cls: string) => out.push({ file, line: lineAt(idx), cls });
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (source.startsWith("className=", i)) {
      const start = i;
      const v = i + "className=".length;
      let end = v;
      if (source[v] === "{") end = skipBraces(source, v);
      else if (source[v] === '"' || source[v] === "'") end = skipQuoted(source, v);
      else if (source[v] === "`") end = skipTemplate(source, v);
      if (end > v) {
        push(start, source.slice(v, end));
        i = end;
        continue;
      }
      i = v;
    } else if (c === "`") {
      const end = skipTemplate(source, i);
      push(i, source.slice(i + 1, end - 1));
      i = end;
    } else if (c === '"' || (c === "'" && !/[A-Za-z0-9]/.test(source[i - 1] ?? ""))) {
      const end = skipQuoted(source, i);
      if (end > i + 1) push(i, source.slice(i + 1, end - 1));
      i = end;
    } else i++;
  }
  return out;
}
