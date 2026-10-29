import { describe, expect, it } from "vitest";
import { exposedFileMatch } from "./probe-types";

describe("exposedFileMatch (SEC-006)", () => {
  it("matches a real .env body and counts its KEY=value lines", () => {
    expect(exposedFileMatch("env_file", "# comment\nDB_HOST=x\nexport API_KEY=abc\r\n\nAPP.NAME = y\n", "text/plain")).toEqual({ pattern: "env_key_value", lines: 3 });
    expect(exposedFileMatch("env_file", "SECRET=1", "application/octet-stream")).toEqual({ pattern: "env_key_value", lines: 1 });
  });

  it("does not match a soft 404, an HTML page or prose", () => {
    expect(exposedFileMatch("env_file", "<!doctype html><p>KEY=value</p>", "text/plain")).toBeNull();
    expect(exposedFileMatch("env_file", "KEY=value\n", "text/html; charset=utf-8")).toBeNull();
    expect(exposedFileMatch("env_file", "Not found\nKEY=value\nsee docs\n", "text/plain")).toBeNull(); // 1 of 3 lines
    expect(exposedFileMatch("env_file", "", "text/plain")).toBeNull();
    expect(exposedFileMatch("env_file", "# only comments\n", "text/plain")).toBeNull();
  });

  it("matches a .git/HEAD ref and nothing else", () => {
    expect(exposedFileMatch("git_head", "ref: refs/heads/main\n", "text/plain")).toEqual({ pattern: "git_head_ref", lines: 1 });
    expect(exposedFileMatch("git_head", "ref: refs/heads/main\n", "text/html")).toBeNull();
    expect(exposedFileMatch("git_head", "<html>ref: refs/heads/main</html>")).toBeNull();
    expect(exposedFileMatch("git_head", "0123abcd\n", "text/plain")).toBeNull();
  });
});
