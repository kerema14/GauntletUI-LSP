const { getContext } = require('./out/parser');

const tests = [
    {
        name: "Tag completion context",
        text: "<",
        offset: 1
    },
    {
        name: "Tag name typing context",
        text: "<TextWid",
        offset: 8
    },
    {
        name: "Attribute completion context",
        text: "<TextWidget ",
        offset: 12
    },
    {
        name: "Attribute name typing context",
        text: "<TextWidget Text",
        offset: 16
    },
    {
        name: "Attribute value completion context",
        text: '<TextWidget Text="',
        offset: 18
    },
    {
        name: "Attribute value typing context",
        text: '<TextWidget Text="hello',
        offset: 23
    },
    {
        name: "Enum value completion context",
        text: '<TextWidget WidthSizePolicy="',
        offset: 29
    },
    {
        name: "Binding completion context",
        text: '<TextWidget Text="@',
        offset: 19
    },
    {
        name: "Command completion context",
        text: '<ButtonWidget Command.Click="@',
        offset: 30
    }
];

console.log("Running LSP Position Parser Tests...");
console.log("=====================================");

for (const t of tests) {
    const ctx = getContext(t.text, t.offset);
    console.log(`\nTest: ${t.name}`);
    console.log(`Input: "${t.text}" at offset ${t.offset}`);
    console.log(`Parsed Context:`);
    console.log(`  - Type:           ${ctx.type}`);
    console.log(`  - Tag Name:       ${ctx.tagName}`);
    console.log(`  - Attribute Name: ${ctx.attributeName}`);
    console.log(`  - Attribute Val:  ${ctx.attributeValue}`);
    console.log(`  - Value Prefix:   ${ctx.valuePrefix}`);
}
