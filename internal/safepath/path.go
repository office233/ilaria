// Package safepath checks existing paths. Hostile concurrent filesystem mutation
// still requires handle-relative OS operations; this is not an OS sandbox.
package safepath
import("fmt";"path/filepath";"strings")
// Resolve BOTH operands, including Windows junctions and short-path aliases.
func Canonical(path string)(string,error){if path==""{return "",fmt.Errorf("empty path")};resolved,err:=filepath.EvalSymlinks(path);if err!=nil{return "",err};return filepath.Abs(resolved)}
func WithinExisting(path,root string)bool{base,err:=Canonical(root);if err!=nil{return false};target,err:=Canonical(path);if err!=nil{return false};rel,err:=filepath.Rel(base,target);return err==nil&&rel!=".."&&!strings.HasPrefix(rel,".."+string(filepath.Separator))&&!filepath.IsAbs(rel)}
func ResolveRelative(root,relative string)(string,error){if relative==""{relative="."};if filepath.IsAbs(relative)||filepath.VolumeName(relative)!=""||strings.ContainsAny(relative,":\\"){return "",fmt.Errorf("a workspace-relative path is required")};clean:=filepath.Clean(relative);if clean==".."||strings.HasPrefix(clean,".."+string(filepath.Separator)){return "",fmt.Errorf("path is outside workspace")};target,err:=Canonical(filepath.Join(root,clean));if err!=nil||!WithinExisting(target,root){return "",fmt.Errorf("path is unavailable or outside workspace")};return target,nil}
