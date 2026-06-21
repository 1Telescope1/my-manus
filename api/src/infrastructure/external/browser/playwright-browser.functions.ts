/** 提取当前视口可见元素的 HTML，用于后续转换 Markdown。 */
export const GET_VISIBLE_CONTENT_FUNC = `() => {
  const visibleElements = [];
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const elements = document.querySelectorAll("body *");

  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i];
    const rect = element.getBoundingClientRect();

    if (rect.height === 0 || rect.width === 0) continue;

    if (
      rect.bottom < 0 ||
      rect.top > viewportHeight ||
      rect.right < 0 ||
      rect.left > viewportWidth
    ) continue;

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) continue;

    if (
      element.innerText ||
      element.tagName === "IMG" ||
      element.tagName === "INPUT" ||
      element.tagName === "BUTTON"
    ) visibleElements.push(element.outerHTML);
  }

  return '<div>' + visibleElements.join(' ') + '</div>';
}`;

/** 提取当前视口内可交互元素，并给每个元素写入 data-manus-id。 */
export const GET_INTERACTIVE_ELEMENTS_FUNC = `() => {
  const interactiveElements = [];
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const elements = document.querySelectorAll('button, a, input, textarea, select, [role="button"], [tabindex]:not([tabindex="-1"])');
  let validElementIndex = 0;

  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i];
    const rect = element.getBoundingClientRect();

    if (rect.width === 0 || rect.height === 0) continue;

    if (
      rect.bottom < 0 ||
      rect.top > viewportHeight ||
      rect.right < 0 ||
      rect.left > viewportWidth
    ) continue;

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) continue;

    const tagName = element.tagName.toLowerCase();
    let text = '';

    if (element.value && ['input', 'textarea', 'select'].includes(tagName)) {
      text = element.value;

      if (tagName === 'input') {
        let labelText = '';
        if (element.id) {
          const label = document.querySelector(\`label[for="\${element.id}"]\`);
          if (label) labelText = label.innerText.trim();
        }

        if (!labelText) {
          const parentLabel = element.closest('label');
          if (parentLabel) {
            labelText = parentLabel.innerText.trim().replace(element.value, '').trim();
          }
        }

        if (labelText) text = \`[Label: \${labelText}] \${text}\`;
        if (element.placeholder) text = \`\${text} [Placeholder: \${element.placeholder}]\`;
      }
    } else if (element.innerText) {
      text = element.innerText.trim().replace(/\\s+/g, ' ');
    } else if (element.alt) {
      text = element.alt;
    } else if (element.title) {
      text = element.title;
    } else if (element.placeholder) {
      text = \`[Placeholder: \${element.placeholder}]\`;
    } else if (element.type) {
      text = \`[\${element.type}]\`;

      if (tagName === 'input') {
        let labelText = '';
        if (element.id) {
          const label = document.querySelector(\`label[for="\${element.id}"]\`);
          if (label) labelText = label.innerText.trim();
        }

        if (!labelText) {
          const parentLabel = element.closest('label');
          if (parentLabel) labelText = parentLabel.innerText.trim();
        }

        if (labelText) text = \`[Label: \${labelText}] \${text}\`;
        if (element.placeholder) text = \`\${text} [Placeholder: \${element.placeholder}]\`;
      }
    } else {
      text = '[No text]';
    }

    if (text.length > 100) {
      text = text.substring(0, 97) + '...';
    }

    element.setAttribute('data-manus-id', \`manus-element-\${validElementIndex}\`);
    const selector = \`[data-manus-id="manus-element-\${validElementIndex}"]\`;

    interactiveElements.push({
      index: validElementIndex,
      tag: tagName,
      text,
      selector,
    });

    validElementIndex += 1;
  }

  return interactiveElements;
}`;

/** 注入 console.log 代理，把页面日志缓存到 window.console.logs。 */
export const INJECT_CONSOLE_LOGS_FUNC = `() => {
  window.console.logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    window.console.logs.push(args.join(" "));
    originalLog.apply(console, args);
  };
}`;

