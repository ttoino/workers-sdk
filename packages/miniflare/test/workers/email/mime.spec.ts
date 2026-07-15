import PostalMime from "postal-mime";
import { describe, it } from "vitest";
import { renderSendingEml } from "../../../src/workers/email/mime";
import type { MessageBuilder } from "../../../src/workers/email/types";

const MESSAGE_ID = "<test-id@example.com>";

function build(overrides: Partial<MessageBuilder>): MessageBuilder {
	return {
		from: "sender@example.com",
		to: "recipient@example.com",
		subject: "hello",
		...overrides,
	};
}

describe("renderSendingEml", () => {
	it("renders a text-only body even when html is an empty string", async ({
		expect,
	}) => {
		// Many parsers (e.g. letterparser) return `html: ""` for a text-only
		// message. The empty string must not shadow the real text body.
		const raw = renderSendingEml(
			build({ text: "Hello, world!", html: "" }),
			MESSAGE_ID
		);
		const email = await PostalMime.parse(raw);

		expect(email.text?.trim()).toBe("Hello, world!");
		expect(email.html).toBeFalsy();
	});

	it("renders an html-only body when text is absent", async ({ expect }) => {
		const raw = renderSendingEml(
			build({ html: "<p>Hi</p>", text: "" }),
			MESSAGE_ID
		);
		const email = await PostalMime.parse(raw);

		expect(email.html).toContain("<p>Hi</p>");
		expect(email.text ?? "").toBe("");
	});

	it("renders both parts as multipart/alternative when text and html are present", async ({
		expect,
	}) => {
		const raw = renderSendingEml(
			build({ text: "plain body", html: "<p>rich body</p>" }),
			MESSAGE_ID
		);
		expect(raw).toContain("multipart/alternative");

		const email = await PostalMime.parse(raw);
		expect(email.text?.trim()).toBe("plain body");
		expect(email.html).toContain("<p>rich body</p>");
	});

	it("wraps content and attachments in multipart/mixed", async ({ expect }) => {
		const raw = renderSendingEml(
			build({
				text: "plain body",
				html: "<p>rich body</p>",
				attachments: [
					{
						disposition: "attachment",
						filename: "note.txt",
						type: "text/plain",
						content: "file contents",
					},
				],
			}),
			MESSAGE_ID
		);
		expect(raw).toContain("multipart/mixed");
		expect(raw).toContain("multipart/alternative");

		const email = await PostalMime.parse(raw, { attachmentEncoding: "base64" });
		expect(email.text?.trim()).toBe("plain body");
		expect(email.html).toContain("<p>rich body</p>");
		expect(email.attachments).toHaveLength(1);
		expect(email.attachments[0]?.filename).toBe("note.txt");
	});
});
