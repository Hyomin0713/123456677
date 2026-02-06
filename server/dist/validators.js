import { z } from "zod";
export const jobSchema = z.enum(["전사", "도적", "궁수", "마법사"]);
export const profileSchema = z.object({
    name: z.string().trim().min(1).max(20),
    job: jobSchema,
    power: z.number().int().nonnegative().max(99999)
});
export const createPartySchema = z.object({
    title: z.string().trim().min(1).max(30).optional(),
    passcode: z.string().trim().min(1).max(20).optional(), // 잠금 비번(선택)
    ...profileSchema.shape
});
export const joinPartySchema = z.object({
    partyId: z.string().trim().min(4).max(32),
    passcode: z.string().trim().min(1).max(20).optional(),
    ...profileSchema.shape
});
export const rejoinSchema = z.object({
    partyId: z.string().trim().min(4).max(32),
    memberId: z.string().trim().min(4).max(64)
});
export const buffsSchema = z.object({
    memberId: z.string().trim().min(4).max(64),
    simbi: z.number().int().nonnegative().max(9999).optional(),
    bbeongbi: z.number().int().nonnegative().max(9999).optional(),
    shopbi: z.number().int().nonnegative().max(9999).optional()
});
export const updateMemberSchema = z.object({
    name: z.string().trim().min(1).max(20).optional(),
    job: jobSchema.optional(),
    power: z.number().int().nonnegative().max(99999).optional()
});
export const updateTitleSchema = z.object({
    memberId: z.string().trim().min(4).max(64),
    title: z.string().trim().min(1).max(30)
});
export const kickSchema = z.object({
    memberId: z.string().trim().min(4).max(64), // 요청자(파티장)
    targetMemberId: z.string().trim().min(4).max(64) // 추방 대상
});
export const transferOwnerSchema = z.object({
    memberId: z.string().trim().min(4).max(64), // 요청자(파티장)
    targetMemberId: z.string().trim().min(4).max(64) // 위임 대상
});
export const lockSchema = z.object({
    memberId: z.string().trim().min(4).max(64), // 요청자(파티장)
    enabled: z.boolean(),
    passcode: z.string().trim().min(1).max(20).optional()
});
