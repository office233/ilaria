package boot
import "testing"
func TestLegacyInstallerCannotClaimAnInstallation(t *testing.T){for _,mode:=range []InstallMode{ModeInPlaceTakeover,ModeBareMetalOverwrite}{logs,err:=NewSystemInstaller().ExecuteDeploy(DeployConfig{Mode:mode,Platform:PlatformBareMetal});if err==nil||len(logs)!=0{t.Fatal("unimplemented installation reported success")}}}
