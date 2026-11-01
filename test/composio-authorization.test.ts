import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {getComposio,authorizeToolkit} from "../server/composio.js";
beforeEach(()=>{vi.stubEnv("COMPOSIO_API_KEY","ak_fixture");vi.stubEnv("COMPOSIO_USER_ID","boop_fixture");});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
describe("Composio hosted connection links",()=>{
  function setup(){
    const client=getComposio()!;
    const configs=vi.spyOn(client.authConfigs,"list").mockResolvedValue({items:[{id:"ac_fixture"}]} as never);
    const accounts=vi.spyOn(client.connectedAccounts,"list").mockResolvedValue({items:[]} as never);
    const link=vi.spyOn(client.connectedAccounts,"link").mockResolvedValue({id:"ca_fixture",redirectUrl:"https://connect.example/consent"} as never);
    const legacy=vi.spyOn(client.connectedAccounts,"initiate").mockRejectedValue(new Error("retired endpoint"));
    return{client,configs,accounts,link,legacy};
  }
  it("uses the supported link API and preserves redirect, callback, alias, and user",async()=>{
    const {link,legacy}=setup();
    const result=await authorizeToolkit("googlecalendar",{callbackUrl:"http://localhost:5174/connections",alias:"Personal calendar"});
    expect(link).toHaveBeenCalledWith("boop_fixture","ac_fixture",{callbackUrl:"http://localhost:5174/connections",alias:"Personal calendar"});
    expect(legacy).not.toHaveBeenCalled();
    expect(result).toEqual({connectionId:"ca_fixture",redirectUrl:"https://connect.example/consent"});
  });
  it("creates a managed auth config when missing before requesting a link",async()=>{
    const {client,configs,link}=setup();configs.mockResolvedValue({items:[]} as never);
    const create=vi.spyOn(client.authConfigs,"create").mockResolvedValue({id:"ac_created"} as never);
    await authorizeToolkit("googlecalendar");
    expect(create).toHaveBeenCalledWith("googlecalendar",expect.objectContaining({type:"use_composio_managed_auth"}));
    expect(link).toHaveBeenCalledWith("boop_fixture","ac_created",{});
  });
  it("allows another account when an active account exists",async()=>{
    const {accounts,link}=setup();
    accounts.mockResolvedValue({items:[{id:"ca_existing",status:"ACTIVE",toolkit:{slug:"googlecalendar"},state:{email:"fixture@example.com"}}]} as never);
    await authorizeToolkit("googlecalendar");
    expect(link).toHaveBeenCalledWith("boop_fixture","ac_fixture",{allowMultiple:true});
  });
  it("propagates link failures rather than falling back to the retired endpoint",async()=>{
    const {link,legacy}=setup();link.mockRejectedValueOnce(new Error("Link temporarily unavailable"));
    await expect(authorizeToolkit("googlecalendar")).rejects.toThrow("Link temporarily unavailable");
    expect(legacy).not.toHaveBeenCalled();
  });
});
