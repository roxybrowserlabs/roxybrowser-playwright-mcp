import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchWithRetries, RoxyAPIRequestContext } from "../../src/apiRequestContext.js";

function createResponseWithSetCookies(
  body: string,
  cookies: string[]
): Response {
  const response = new Response(body, {
    status: 200,
    statusText: "OK"
  });
  Object.defineProperty(response.headers, "getSetCookie", {
    value: () => cookies
  });
  return response;
}

describe("RoxyAPIRequestContext", () => {
  it("returns redirect responses with location when maxRedirects is 0", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(302, {
        location: "/target"
      });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not bind to a TCP port");
    }

    try {
      const response = await fetchWithRetries(`http://127.0.0.1:${address.port}/source`, {
        headers: {},
        maxRedirects: 0,
        method: "GET"
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/target");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("includes status text and response text in failOnStatusCode errors", async () => {
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("File not found: missing.html", {
        headers: {
          "content-type": "text/plain"
        },
        status: 404,
        statusText: "Not Found"
      })
    );

    try {
      const error = await request
        .fetch("https://example.com/missing.html", { failOnStatusCode: true })
        .catch((caught: Error) => caught);
      expect(error.message).toContain("404 Not Found");
      expect(error.message).toContain("Response text:\nFile not found: missing.html");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("supports multipart FormData with repeated names, File, and Blob", async () => {
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("OK", {
        status: 200,
        statusText: "OK"
      })
    );
    const formData = new FormData();
    formData.set("name", "John");
    formData.append("name", "Doe");
    formData.append(
      "file",
      new File(["var x = 10;\r\n;console.log(x);"], "f1.js", { type: "text/javascript" })
    );
    formData.append("file", new File(["hello"], "f2.txt", { type: "text/plain" }), "custom_f2.txt");
    formData.append("file", new Blob(["boo"], { type: "text/plain" }));

    try {
      await request.post("https://example.com/upload", {
        multipart: formData
      });

      const init = fetchSpy.mock.calls[0]?.[1];
      expect(init).toBeTruthy();
      expect(init?.headers).toEqual(
        expect.objectContaining({
          "content-length": expect.any(String),
          "content-type": expect.stringContaining("multipart/form-data; boundary=")
        })
      );
      const body = Buffer.from(init?.body as Buffer).toString("utf8").toLowerCase();
      expect(body).toContain('content-disposition: form-data; name="name"\r\n\r\njohn');
      expect(body).toContain('content-disposition: form-data; name="name"\r\n\r\ndoe');
      expect(body).toContain(
        'content-disposition: form-data; name="file"; filename="f1.js"\r\ncontent-type: text/javascript\r\n\r\nvar x = 10;\r\n;console.log(x);'
      );
      expect(body).toContain(
        'content-disposition: form-data; name="file"; filename="custom_f2.txt"\r\ncontent-type: text/plain\r\n\r\nhello'
      );
      expect(body).toContain(
        'content-disposition: form-data; name="file"; filename="blob"\r\ncontent-type: text/plain\r\n\r\nboo'
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("supports multipart object payloads with ReadStream values", async () => {
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("OK", {
        status: 200,
        statusText: "OK"
      })
    );
    const directory = await mkdtemp(join(tmpdir(), "roxy-api-request-"));
    const filePath = join(directory, "payload.json");
    await writeFile(filePath, '{"ok":true}');

    try {
      await request.post("https://example.com/upload", {
        multipart: {
          firstName: "John",
          readStream: createReadStream(filePath)
        }
      });

      const init = fetchSpy.mock.calls[0]?.[1];
      expect(init?.headers).toEqual(
        expect.objectContaining({
          "content-length": expect.any(String),
          "content-type": expect.stringContaining("multipart/form-data; boundary=")
        })
      );
      const body = Buffer.from(init?.body as Buffer).toString("utf8");
      expect(body).toContain('Content-Disposition: form-data; name="firstName"\r\n\r\nJohn');
      expect(body).toContain(
        'Content-Disposition: form-data; name="readStream"; filename="payload.json"\r\nContent-Type: application/json\r\n\r\n{"ok":true}'
      );
    } finally {
      fetchSpy.mockRestore();
      expect(await readFile(filePath, "utf8")).toBe('{"ok":true}');
    }
  });

  it("throws the dispose reason on later calls", async () => {
    const request = new RoxyAPIRequestContext();
    await request.dispose({ reason: "manual close" });
    await expect(request.get("https://example.com")).rejects.toThrow("manual close");
  });

  it("serializes FormData form bodies with repeated names", async () => {
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("OK", {
        status: 200,
        statusText: "OK"
      })
    );
    const form = new FormData();
    form.append("foo", "1");
    form.append("foo", "2");

    try {
      await request.post("https://example.com/form", { form });
      const init = fetchSpy.mock.calls[0]?.[1];
      expect(init?.headers).toEqual({
        "content-length": "11",
        "content-type": "application/x-www-form-urlencoded"
      });
      const body = Buffer.from(init?.body as Buffer).toString("utf8");
      const params = new URLSearchParams(body);
      expect(params.getAll("foo")).toEqual(["1", "2"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("encodes object data as json by default with content-length", async () => {
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("OK", {
        status: 200,
        statusText: "OK"
      })
    );
    const data = {
      firstName: "John",
      lastName: "Doe",
      file: {
        name: "f.js"
      }
    };

    try {
      await request.post("https://example.com/data", { data });
      const init = fetchSpy.mock.calls[0]?.[1];
      const expectedBody = JSON.stringify(data);
      expect(init?.headers).toEqual({
        "content-length": String(Buffer.byteLength(expectedBody, "utf8")),
        "content-type": "application/json"
      });
      expect(Buffer.from(init?.body as Buffer).toString("utf8")).toBe(expectedBody);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not append response text for HEAD failOnStatusCode errors", async () => {
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", {
        status: 404,
        statusText: "Not Found"
      })
    );

    try {
      const error = await request
        .head("https://example.com/missing.html", { failOnStatusCode: true })
        .catch((caught: Error) => caught);
      expect(error.message).toContain("404 Not Found");
      expect(error.message).not.toContain("Response text:");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("creates parent directories when writing storageState to disk", async () => {
    const request = new RoxyAPIRequestContext();
    const directory = await mkdtemp(join(tmpdir(), "roxy-storage-state-"));
    const outputPath = join(directory, "nested", "state.json");

    const state = await request.storageState({ path: outputPath });

    expect(state).toEqual({ cookies: [], origins: [] });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(state);
  });

  it("exports cookies from Set-Cookie headers", async () => {
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createResponseWithSetCookies("ok", [
        "a=b",
        "c=d; expires=Wed, 01 Jan 2031 00:00:00 GMT; domain=b.one.com; path=/input"
      ]));

    try {
      await request.get("http://a.b.one.com:3000/setcookie.html");
      expect(await request.storageState()).toEqual({
        cookies: [
          {
            domain: "a.b.one.com",
            expires: -1,
            httpOnly: false,
            name: "a",
            path: "/",
            sameSite: "Lax",
            secure: false,
            value: "b"
          },
          {
            domain: ".b.one.com",
            expires: Math.floor(Date.parse("Wed, 01 Jan 2031 00:00:00 GMT") / 1000),
            httpOnly: false,
            name: "c",
            path: "/input",
            sameSite: "Lax",
            secure: false,
            value: "d"
          }
        ],
        origins: []
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("sends stored cookies on matching later requests, including secure localhost cookies", async () => {
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createResponseWithSetCookies("ok", ["a=v; secure"]))
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          statusText: "OK"
        })
      );

    try {
      await request.get("http://localhost/setcookie.html");
      await request.get("http://localhost/empty.html");
      expect(fetchSpy.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          headers: {
            cookie: "a=v"
          }
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("removes cookies when a later Set-Cookie expires them", async () => {
    const request = new RoxyAPIRequestContext();
    const pastDateString = new Date(1970, 0, 1, 0, 0, 0, 0).toUTCString();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createResponseWithSetCookies("ok", ["a=ok"]))
      .mockResolvedValueOnce(createResponseWithSetCookies("ok", [`a=; expires=${pastDateString}`]))
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          statusText: "OK"
        })
      );

    try {
      await request.get("https://example.com/setcookie.html");
      await request.get("https://example.com/unset.html");
      await request.get("https://example.com/final.html");
      expect(fetchSpy.mock.calls[2]?.[1]).toEqual(
        expect.objectContaining({
          headers: {}
        })
      );
      expect(await request.storageState()).toEqual({
        cookies: [],
        origins: []
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
