// 대화형 입력 도우미.
// 표준 readline.question은 질문이 대기 중일 때 도착한 줄만 받는다.
// 사용자가 여러 줄을 한 번에 붙여넣으면 나머지 줄이 버려지므로,
// 모든 줄을 큐에 쌓아두고 질문이 오면 순서대로 꺼내준다.
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

const queue = [];
let pending = null;
let closed = false;

rl.on("line", (line) => {
  if (pending) {
    const resolve = pending;
    pending = null;
    resolve(line);
  } else {
    queue.push(line);
  }
});

rl.on("close", () => {
  closed = true;
  if (pending) {
    const resolve = pending;
    pending = null;
    resolve("");
  }
});

export function ask(promptText) {
  if (queue.length > 0) {
    const line = queue.shift();
    output.write(promptText + line + "\n");
    return Promise.resolve(line);
  }
  if (closed) return Promise.resolve("");
  output.write(promptText);
  return new Promise((resolve) => {
    pending = resolve;
  });
}

// 입력이 끝났는지 (파이프 EOF, Ctrl+C 등) — 무한 재질문 루프 방지용
export function inputClosed() {
  return closed;
}

export function closePrompt() {
  if (!closed) rl.close();
}
