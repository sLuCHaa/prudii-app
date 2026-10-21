import { Node } from "@tiptap/core";

// Keeps the signature wrapper so it can be found and swapped on account change.
export const SignatureNode = Node.create({
  name: "signature",
  group: "block",
  content: "block*",
  parseHTML() {
    // The divider is added on the way out (addSignatureDivider); drafts and restores bring it back in.
    return [{ tag: 'div[data-type="signature"]' }, { tag: "table[data-prudii-divider]", ignore: true }];
  },
  renderHTML() {
    return ["div", { "data-type": "signature" }, 0];
  },
  renderText({ node }) {
    const text = node.textBetween(0, node.content.size, "\n\n", (leaf) => (leaf.type.name === "hardBreak" ? "\n" : ""));
    // "-- " on a line of its own is the standard delimiter mail programs recognise a signature by.
    return text.trim() ? `-- \n${text}` : "";
  },
});
