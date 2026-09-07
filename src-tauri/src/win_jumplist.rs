//! Taskbar jump list: registers a single "New message" user task that
//! launches the app with `--compose`.

#![cfg(windows)]

// Registers the "New message" task in the taskbar jump list. Failures are
// logged only — the jump list is a convenience, never a start-up blocker.
pub fn install(new_message_label: &str) {
    if let Err(e) = install_inner(new_message_label) {
        log::warn!("jump list not installed: {e}");
    }
}

fn install_inner(label: &str) -> windows::core::Result<()> {
    use windows::core::{Interface, GUID, HSTRING};
    use windows::Win32::Foundation::{E_FAIL, PROPERTYKEY, RPC_E_CHANGED_MODE};
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
        ShellLink,
    };

    // PKEY_Title = {F29F85E0-4FF9-1068-AB91-08002B27B3D9}, 2 — built by hand
    // rather than pulling in the Win32_Storage_EnhancedStorage feature for
    // one constant.
    const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xF29F85E0_4FF9_1068_AB91_08002B27B3D9),
        pid: 2,
    };

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // RPC_E_CHANGED_MODE only means another component initialised COM first.
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            return Err(hr.into());
        }

        let exe = std::env::current_exe()
            .map_err(|e| windows::core::Error::new(E_FAIL, e.to_string()))?;
        let exe_h = HSTRING::from(exe.as_os_str());

        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&exe_h)?;
        link.SetArguments(&HSTRING::from("--compose"))?;
        link.SetIconLocation(&exe_h, 0)?;

        let title_var = PROPVARIANT::from(label);
        let store: IPropertyStore = link.cast()?;
        store.SetValue(&PKEY_TITLE, &title_var)?;
        store.Commit()?;

        let list: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots = 0u32;
        let _removed: IObjectArray = list.BeginList(&mut slots)?;
        let tasks: IObjectCollection =
            CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        tasks.AddObject(&link)?;
        let tasks_array: IObjectArray = tasks.cast()?;
        list.AddUserTasks(&tasks_array)?;
        list.CommitList()?;
    }
    Ok(())
}
