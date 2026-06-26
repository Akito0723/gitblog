let codeBlocksHighlighted = false;

function highlightCodeBlocks() {
  if (codeBlocksHighlighted || !window.hljs) {
    return;
  }

  window.hljs.highlightAll();
  codeBlocksHighlighted = true;
}

highlightCodeBlocks();
window.addEventListener("load", highlightCodeBlocks);
