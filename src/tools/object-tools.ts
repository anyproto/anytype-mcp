import type { JSONSchema7 as IJsonSchema } from "json-schema";
import { z } from "zod";

// ============================================================================
// 1. Zod Discriminated Union for Property Values
// ============================================================================

export const TextPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'description', 'notes')"),
  format: z.literal("text"),
  text: z.string().describe("The text value of the property"),
});

export const NumberPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'priority', 'count')"),
  format: z.literal("number"),
  number: z.number().describe("The numerical value of the property"),
});

export const SelectPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'status')"),
  format: z.literal("select"),
  select: z.string().describe("Selected tag key or ID"),
});

export const MultiSelectPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'tags')"),
  format: z.literal("multi_select"),
  multi_select: z.array(z.string()).describe("Array of selected tag keys or IDs"),
});

export const DatePropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'due_date')"),
  format: z.literal("date"),
  date: z.string().describe("Date in RFC3339 or ISO 8601 format (e.g. '2026-08-21T12:00:00Z' or '2026-08-21')"),
});

export const FilesPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'attachments')"),
  format: z.literal("files"),
  files: z.array(z.string()).describe("Array of file IDs"),
});

export const CheckboxPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'done', 'archived')"),
  format: z.literal("checkbox"),
  checkbox: z.boolean().describe("Boolean checkbox state (true/false)"),
});

export const UrlPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'website', 'source')"),
  format: z.literal("url"),
  url: z.string().describe("URL string"),
});

export const EmailPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'email', 'contact')"),
  format: z.literal("email"),
  email: z.string().describe("Email address"),
});

export const PhonePropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'phone')"),
  format: z.literal("phone"),
  phone: z.string().describe("Phone number string"),
});

export const ObjectsPropertySchema = z.object({
  key: z.string().describe("The property key (e.g. 'relations', 'links')"),
  format: z.literal("objects"),
  objects: z.array(z.string()).describe("Array of linked object IDs"),
});

export const PropertyValueSchema = z.discriminatedUnion("format", [
  TextPropertySchema,
  NumberPropertySchema,
  SelectPropertySchema,
  MultiSelectPropertySchema,
  DatePropertySchema,
  FilesPropertySchema,
  CheckboxPropertySchema,
  UrlPropertySchema,
  EmailPropertySchema,
  PhonePropertySchema,
  ObjectsPropertySchema,
]);

// ============================================================================
// 2. Handcrafted Zod Schemas for Icons and Objects
// ============================================================================

export const EmojiIconSchema = z.object({
  emoji: z.string().describe("Emoji character for the icon (e.g. '📄', '🚀')"),
  format: z.literal("emoji").optional().describe("Icon format ('emoji')"),
});

export const FileIconSchema = z.object({
  file: z.string().describe("File ID of the icon image"),
  format: z.literal("file").describe("Icon format ('file')"),
});

export const NamedIconSchema = z.object({
  name: z.string().describe("Name of the icon (e.g. 'alarm', 'archive', 'star')"),
  color: z.string().optional().describe("Color of the icon"),
  format: z.literal("icon").optional().describe("Icon format ('icon')"),
});

export const IconSchema = z
  .union([EmojiIconSchema, FileIconSchema, NamedIconSchema])
  .nullable()
  .describe("The icon of the object, or null to remove the icon");

export const CreateObjectSchema = z
  .object({
    space_id: z.string().describe("The ID of the space to create the object in"),
    type_key: z.string().describe("The key of the object type (e.g. 'page', 'task', 'bookmark')"),
    name: z.string().optional().describe("The name of the object"),
    body: z.string().optional().describe("The initial body text or markdown of the object"),
    icon: IconSchema.optional(),
    template_id: z.string().optional().describe("The ID of the template to instantiate from"),
    properties: z.array(PropertyValueSchema).optional().describe("Object properties to set"),
  })
  .passthrough();

export const UpdateObjectSchema = z
  .object({
    space_id: z.string().describe("The ID of the space containing the object"),
    object_id: z.string().describe("The ID of the object to update"),
    name: z.string().optional().describe("The updated name of the object"),
    markdown: z.string().optional().describe("The updated markdown body of the object"),
    icon: IconSchema.optional(),
    type_key: z.string().optional().describe("The key of the type of object"),
    properties: z.array(PropertyValueSchema).optional().describe("Object properties to set/update"),
  })
  .passthrough();

export interface ToolOverride {
  zodSchema: z.ZodType;
  inputSchema: IJsonSchema & { type: "object" };
}

/**
 * Generate a clean JSON Schema without root $schema header for MCP / LLM compatibility.
 */
function cleanJsonSchema(schema: z.ZodType): IJsonSchema & { type: "object" } {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, any>;
  delete jsonSchema.$schema;
  return jsonSchema as IJsonSchema & { type: "object" };
}

// ============================================================================
// 3. Tool Overrides Registry
// ============================================================================

export const ToolOverrides: Record<string, ToolOverride> = {
  "API-create-object": {
    zodSchema: CreateObjectSchema,
    inputSchema: cleanJsonSchema(CreateObjectSchema),
  },
  "API-update-object": {
    zodSchema: UpdateObjectSchema,
    inputSchema: cleanJsonSchema(UpdateObjectSchema),
  },
};
