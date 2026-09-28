package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// SwypikInstaller writes the 1-click launcher. It never reads, moves or
// modifies user folders, which is its only data-safety property.
type SwypikInstaller struct {
	InstallDir   string
	UserProfile  string
	DesktopDir   string
	DocumentsDir string
	DownloadsDir string
}

func NewInstaller() *SwypikInstaller {
	userProfile := os.Getenv("USERPROFILE")
	if userProfile == "" {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			userProfile = home
		} else {
			userProfile = "C:\\Users\\Default"
		}
	}

	executable, err := os.Executable()
	if err != nil {
		panic(fmt.Errorf("locate installer: %w", err))
	}
	installDir := filepath.Dir(executable)
	if filepath.Base(installDir) == "bin" {
		installDir = filepath.Dir(installDir)
	}

	return &SwypikInstaller{
		InstallDir:   installDir,
		UserProfile:  userProfile,
		DesktopDir:   filepath.Join(userProfile, "Desktop"),
		DocumentsDir: filepath.Join(userProfile, "Documents"),
		DownloadsDir: filepath.Join(userProfile, "Downloads"),
	}
}

// DescribeUserDataScope states which user folders the installer leaves alone.
// It checks nothing: the guarantee comes from never touching these paths.
func (i *SwypikInstaller) DescribeUserDataScope() {
	fmt.Printf("[SCOPE] The installer does not read, move or modify: %s\n", i.UserProfile)
	fmt.Printf("        - Desktop:   %s\n", i.DesktopDir)
	fmt.Printf("        - Documents: %s\n", i.DocumentsDir)
	fmt.Printf("        - Downloads: %s\n", i.DownloadsDir)
}

// CreateLauncherShortcut creates a 1-click batch launcher and desktop shortcut.
func (i *SwypikInstaller) CreateLauncherShortcut() error {
	exePath := filepath.Join(i.InstallDir, "bin", "swypik-os.exe")
	if info, err := os.Stat(exePath); err != nil || info.IsDir() {
		return fmt.Errorf("swypik-os.exe not found at %s; run scripts/build.ps1", exePath)
	}

	batContent := "@echo off\r\ncd /d \"%~dp0\"\r\nstart \"\" \"%~dp0bin\\swypik-os.exe\" %*\r\n"
	batPath := filepath.Join(i.InstallDir, "Start-SwypikOS.bat")
	if err := os.MkdirAll(i.InstallDir, 0755); err != nil {
		return err
	}
	if err := os.WriteFile(batPath, []byte(batContent), 0755); err != nil {
		return err
	}

	fmt.Printf("[INSTALL] Created 1-Click Launcher: %s\n", batPath)
	return nil
}

// ShowSuccessDialog displays a native Windows MessageBox.
func ShowSuccessDialog(msg, title string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBoxW := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(msg)
	messageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x00000040)
}

func main() {
	fmt.Println("==========================================================")
	fmt.Println("        SWYPIKOS 1-CLICK LAUNCHER INSTALLER (WINDOWS)     ")
	fmt.Println("==========================================================")

	installer := NewInstaller()
	installer.DescribeUserDataScope()

	if err := installer.CreateLauncherShortcut(); err != nil {
		fmt.Printf("[ERROR] Installation failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("[SUCCESS] SwypikOS launcher created.")
	fmt.Println("          - Native binary, no Electron")
	fmt.Println("          - User folders were not touched")
	fmt.Println("==========================================================")
}
