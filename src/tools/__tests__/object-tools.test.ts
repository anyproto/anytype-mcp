import { describe, expect, it } from "vitest";
import {
  CreateObjectSchema,
  IconSchema,
  PropertyValueSchema,
  ToolOverrides,
  UpdateObjectSchema,
} from "../object-tools";

describe("Object Tools Zod Schemas", () => {
  describe("PropertyValueSchema Discriminated Union (All 11 Types)", () => {
    it("should parse 'text' property", () => {
      const input = { key: "notes", format: "text", text: "Hello Anytype" };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'number' property including 0", () => {
      const input = { key: "count", format: "number", number: 0 };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'select' property and strip unknown properties", () => {
      const input = {
        key: "status",
        format: "select",
        select: "tag_active",
        text: "", // extraneous
        number: 0, // extraneous
      };

      const result = PropertyValueSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({
          key: "status",
          format: "select",
          select: "tag_active",
        });
      }
    });

    it("should parse 'multi_select' property", () => {
      const input = { key: "tags", format: "multi_select", multi_select: ["tag1", "tag2"] };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'date' property", () => {
      const input = { key: "due_date", format: "date", date: "2026-08-21T12:00:00Z" };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'files' property", () => {
      const input = { key: "attachments", format: "files", files: ["bafy1", "bafy2"] };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'checkbox' property including false", () => {
      const input = { key: "done", format: "checkbox", checkbox: false };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'url' property", () => {
      const input = { key: "source", format: "url", url: "https://example.com" };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'email' property", () => {
      const input = { key: "contact", format: "email", email: "user@example.com" };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'phone' property", () => {
      const input = { key: "support", format: "phone", phone: "+1234567890" };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should parse 'objects' property", () => {
      const input = { key: "links", format: "objects", objects: ["bafyobj1", "bafyobj2"] };
      const res = PropertyValueSchema.safeParse(input);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toEqual(input);
    });

    it("should reject invalid format or missing required payload", () => {
      expect(PropertyValueSchema.safeParse({ key: "k", format: "unknown" }).success).toBe(false);
      expect(PropertyValueSchema.safeParse({ key: "k", format: "select" }).success).toBe(false);
    });
  });

  describe("IconSchema", () => {
    it("should validate emoji icon", () => {
      const res = IconSchema.safeParse({ emoji: "🚀", format: "emoji" });
      expect(res.success).toBe(true);
    });

    it("should validate file icon", () => {
      const res = IconSchema.safeParse({ file: "bafyimage123", format: "file" });
      expect(res.success).toBe(true);
    });

    it("should validate named icon", () => {
      const res = IconSchema.safeParse({ name: "alarm", color: "blue", format: "icon" });
      expect(res.success).toBe(true);
    });

    it("should validate null to clear icon", () => {
      const res = IconSchema.safeParse(null);
      expect(res.success).toBe(true);
      if (res.success) expect(res.data).toBeNull();
    });
  });

  describe("CreateObjectSchema", () => {
    it("should validate valid create-object payload with properties", () => {
      const input = {
        space_id: "space_123",
        type_key: "page",
        name: "My Note",
        body: "Initial text",
        icon: { emoji: "📝", format: "emoji" },
        properties: [
          { key: "status", format: "select", select: "tag_1" },
          { key: "priority", format: "number", number: 1 },
        ],
      };

      const result = CreateObjectSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should fail when space_id or type_key is missing", () => {
      expect(CreateObjectSchema.safeParse({ type_key: "page", name: "No space" }).success).toBe(false);
      expect(CreateObjectSchema.safeParse({ space_id: "space_123", name: "No type" }).success).toBe(false);
    });
  });

  describe("UpdateObjectSchema", () => {
    it("should validate valid update-object payload", () => {
      const input = {
        space_id: "space_123",
        object_id: "obj_456",
        name: "Updated Note",
        markdown: "# New content",
        icon: null,
        properties: [{ key: "done", format: "checkbox", checkbox: true }],
      };

      const result = UpdateObjectSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it("should fail when object_id is missing", () => {
      expect(UpdateObjectSchema.safeParse({ space_id: "space_123", name: "Missing obj" }).success).toBe(false);
    });
  });

  describe("ToolOverrides Registry", () => {
    it("should contain API-create-object and API-update-object overrides with clean JSON Schema", () => {
      expect(ToolOverrides["API-create-object"]).toBeDefined();
      expect(ToolOverrides["API-update-object"]).toBeDefined();

      const createSchema = ToolOverrides["API-create-object"].inputSchema;
      expect(createSchema.type).toBe("object");
      expect(createSchema.properties).toHaveProperty("space_id");
      expect(createSchema.properties).toHaveProperty("type_key");
      expect(createSchema.properties).toHaveProperty("properties");
      // Check that root $schema is removed for OpenAI/MCP compatibility
      expect(createSchema).not.toHaveProperty("$schema");

      const updateSchema = ToolOverrides["API-update-object"].inputSchema;
      expect(updateSchema.type).toBe("object");
      expect(updateSchema.properties).toHaveProperty("space_id");
      expect(updateSchema.properties).toHaveProperty("object_id");
      expect(updateSchema).not.toHaveProperty("$schema");
    });
  });
});
