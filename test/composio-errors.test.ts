import {describe,it,expect} from "vitest";
import {composioPermissionHint} from "../server/composio-errors.js";
describe("calendar permission errors",()=>{
 it("explains a connected-but-under-scoped Calendar token",()=>{
  const text=composioPermissionHint("googlecalendar",{successful:false,error:JSON.stringify({error:{code:403,message:"Request had insufficient authentication scopes.",details:[{reason:"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}})});
  expect(text).toContain("Reconnect Google Calendar");expect(text).toContain("calendar.calendarlist.readonly");
 });
 it("does not reinterpret successful results or unrelated failures",()=>{
  expect(composioPermissionHint("googlecalendar",{successful:true,error:"insufficientPermissions"})).toBeNull();
  expect(composioPermissionHint("gmail",{successful:false,error:"insufficientPermissions"})).toBeNull();
  expect(composioPermissionHint("googlecalendar",{successful:false,error:"network timeout"})).toBeNull();
 });
});
