export type ContextType = 'tag' | 'attribute' | 'value' | 'binding' | 'none';

export interface PositionContext {
    type: ContextType;
    tagName: string;
    attributeName: string;
    attributeValue: string;
    inQuotes: boolean;
    quoteChar: string;
    valuePrefix: string;
    tagStack: string[];
}

export function getContext(text: string, offset: number): PositionContext {
    let state: 'TEXT' | 'TAG_NAME' | 'TAG_BODY' | 'ATTR_NAME' | 'ATTR_VALUE' = 'TEXT';
    let tagName = '';
    let attributeName = '';
    let attributeValue = '';
    let quoteChar = '';
    let inQuotes = false;
    
    // Stack to track tag hierarchy
    const tagStack: string[] = [];

    let i = 0;
    while (i < offset) {
        const char = text[i];
        
        if (state === 'TEXT') {
            if (char === '<') {
                if (text.startsWith('<!--', i)) {
                    const closeIndex = text.indexOf('-->', i);
                    if (closeIndex !== -1 && closeIndex < offset) {
                        i = closeIndex + 2;
                    } else {
                        break;
                    }
                } else if (text.startsWith('</', i)) {
                    const closeIndex = text.indexOf('>', i);
                    if (closeIndex !== -1 && closeIndex < offset) {
                        const closedTagName = text.substring(i + 2, closeIndex).trim().split(/\s+/)[0];
                        const idx = tagStack.lastIndexOf(closedTagName);
                        if (idx !== -1) {
                            tagStack.splice(idx);
                        }
                        i = closeIndex;
                    } else {
                        break;
                    }
                } else {
                    state = 'TAG_NAME';
                    tagName = '';
                    attributeName = '';
                    attributeValue = '';
                }
            }
        } else if (state === 'TAG_NAME') {
            if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
                state = 'TAG_BODY';
                tagStack.push(tagName);
            } else if (char === '>') {
                state = 'TEXT';
                tagStack.push(tagName);
            } else if (char === '/') {
                if (text[i + 1] === '>') {
                    state = 'TEXT';
                    i++;
                }
            } else {
                tagName += char;
            }
        } else if (state === 'TAG_BODY') {
            if (char === '>') {
                state = 'TEXT';
            } else if (char === '/') {
                if (text[i + 1] === '>') {
                    state = 'TEXT';
                    tagStack.pop();
                    i++;
                }
            } else if (char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n') {
                state = 'ATTR_NAME';
                attributeName = char;
            }
        } else if (state === 'ATTR_NAME') {
            if (char === '=') {
                state = 'TAG_BODY';
                let nextIdx = i + 1;
                while (nextIdx < offset && (text[nextIdx] === ' ' || text[nextIdx] === '\t' || text[nextIdx] === '\r' || text[nextIdx] === '\n')) {
                    nextIdx++;
                }
                if (nextIdx < offset && (text[nextIdx] === '"' || text[nextIdx] === "'")) {
                    quoteChar = text[nextIdx];
                    state = 'ATTR_VALUE';
                    attributeValue = '';
                    inQuotes = true;
                    i = nextIdx;
                }
            } else if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
                // Look ahead to see if there is an '=' after whitespace
                let nextIdx = i + 1;
                while (nextIdx < text.length && (text[nextIdx] === ' ' || text[nextIdx] === '\t' || text[nextIdx] === '\r' || text[nextIdx] === '\n')) {
                    nextIdx++;
                }
                if (nextIdx < text.length && text[nextIdx] === '=') {
                    // Skip whitespace so that the '=' will be processed by the next iteration in ATTR_NAME state
                    i = nextIdx - 1;
                } else {
                    state = 'TAG_BODY';
                }
            } else if (char === '>') {
                state = 'TEXT';
            } else {
                attributeName += char;
            }
        } else if (state === 'ATTR_VALUE') {
            if (char === quoteChar) {
                state = 'TAG_BODY';
                inQuotes = false;
                attributeName = '';
            } else {
                attributeValue += char;
            }
        }
        i++;
    }

    let type: ContextType = 'none';
    const activeTagName = tagStack[tagStack.length - 1] || tagName || '';
    
    if (state === 'TAG_NAME') {
        type = 'tag';
    } else if (state === 'TAG_BODY') {
        type = 'attribute';
    } else if (state === 'ATTR_NAME') {
        type = 'attribute';
    } else if (state === 'ATTR_VALUE') {
        if (attributeValue.startsWith('@')) {
            type = 'binding';
        } else {
            type = 'value';
        }
    }

    let valuePrefix = '';
    if (type === 'binding' || type === 'value') {
        if (attributeValue.startsWith('@')) valuePrefix = '@';
        else if (attributeValue.startsWith('!')) valuePrefix = '!';
        else if (attributeValue.startsWith('*')) valuePrefix = '*';
        else if (attributeValue.startsWith('{')) valuePrefix = '{';
    }

    return {
        type,
        tagName: activeTagName,
        attributeName: (state === 'ATTR_VALUE' || state === 'ATTR_NAME') ? attributeName : '',
        attributeValue,
        inQuotes,
        quoteChar,
        valuePrefix,
        tagStack
    };
}
