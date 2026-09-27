//go:build linux && amd64

package main
import("flag";"fmt";"os";"os/signal";"syscall";"context";"swypik-os/core/session")
func main(){socket:=flag.String("socket","/run/swypik/control.sock","Private native IPC socket");fb:=flag.String("framebuffer","/dev/fb0","Linux framebuffer");flag.Parse();if os.Geteuid()==0{fmt.Fprintln(os.Stderr,"Refusing to run the desktop session as root");os.Exit(1)};ctx,stop:=signal.NotifyContext(context.Background(),os.Interrupt,syscall.SIGTERM);defer stop();if err:=session.Run(ctx,*socket,*fb);err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}}
