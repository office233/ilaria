// Un VM Swypik (orice rol): NIC cu IP privat static + VM Ubuntu 24.04.
// Folosit de main.bicep pentru rolurile web / data / worker.

@description('Numele VM-ului.')
param name string

param location string
param tags object

@allowed([
  'web'
  'data'
  'worker'
])
param role string

param vmSize string
param subnetId string

@description('IP privat static în subnet (ex. 10.60.1.10).')
param privateIp string

@description('ID-ul unui IP public de atașat (doar jump host-ul web-1, opțional). Gol = fără IP public.')
param publicIpId string = ''

param adminUsername string
param adminSshPublicKey string

@description('cloud-init deja particularizat pe rol (text).')
param customData string

@allowed([
  'Premium_LRS'
  'StandardSSD_LRS'
])
param osDiskType string = 'StandardSSD_LRS'
param osDiskSizeGB int = 64

@description('Disc de date Premium SSD v2 (GiB) pe LUN 0; 0 = fără disc de date.')
param dataDiskSizeGB int = 0

@description('IOPS / MB/s provizionate pe discul de date Premium SSD v2.')
param dataDiskIops int = 3000
param dataDiskMBps int = 125

@description('Zona de disponibilitate (Premium SSD v2 cere VM și disc în aceeași zonă). Gol = fără zonă.')
param zone string = ''

@description('Controlerul de discuri: v6/v7 cer NVMe; v5 folosește SCSI.')
@allowed([
  'NVMe'
  'SCSI'
])
param diskControllerType string = 'NVMe'

@description('VM Spot (evacuabil; doar pentru worker-e fără stare).')
param useSpot bool = false

var hasDataDisk = dataDiskSizeGB > 0
var zones = empty(zone) ? null : [
  zone
]

// Discul Postgres: resursă separată (supraviețuiește ștergerii VM-ului). Premium SSD v2
// nu suportă cache pe host și cere aceeași zonă ca VM-ul.
resource dataDisk 'Microsoft.Compute/disks@2024-03-02' = if (hasDataDisk) {
  name: '${name}-data'
  location: location
  tags: union(tags, {
    role: role
  })
  zones: zones
  sku: {
    name: 'PremiumV2_LRS'
  }
  properties: {
    creationData: {
      createOption: 'Empty'
    }
    diskSizeGB: dataDiskSizeGB
    diskIOPSReadWrite: dataDiskIops
    diskMBpsReadWrite: dataDiskMBps
  }
}
var roleTags = union(tags, {
  role: role
})

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${name}-nic'
  location: location
  tags: roleTags
  properties: {
    enableAcceleratedNetworking: true
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Static'
          privateIPAddress: privateIp
          subnet: {
            id: subnetId
          }
          publicIPAddress: empty(publicIpId) ? null : {
            id: publicIpId
          }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: name
  location: location
  tags: roleTags
  zones: zones
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    priority: useSpot ? 'Spot' : 'Regular'
    evictionPolicy: useSpot ? 'Deallocate' : null
    billingProfile: useSpot ? {
      // -1 = plătește până la prețul pay-as-you-go; evacuare doar la lipsă de capacitate.
      maxPrice: -1
    } : null
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
    osProfile: {
      computerName: name
      adminUsername: adminUsername
      customData: base64(customData)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
        provisionVMAgent: true
        patchSettings: {
          // Actualizările de securitate le face unattended-upgrades (cloud-init).
          patchMode: 'ImageDefault'
          assessmentMode: 'ImageDefault'
        }
      }
    }
    storageProfile: {
      diskControllerType: diskControllerType
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        name: '${name}-osdisk'
        createOption: 'FromImage'
        diskSizeGB: osDiskSizeGB
        caching: 'ReadWrite'
        deleteOption: 'Delete'
        managedDisk: {
          storageAccountType: osDiskType
        }
      }
      dataDisks: hasDataDisk ? [
        {
          // LUN 0 → /dev/disk/azure/data/by-lun/0 (NVMe) sau scsi1/lun0 (SCSI); formatat + montat /srv/data de cloud-init
          lun: 0
          createOption: 'Attach'
          caching: 'None'
          // Discul cu Postgres supraviețuiește ștergerii VM-ului.
          deleteOption: 'Detach'
          managedDisk: {
            id: dataDisk.id
          }
        }
      ] : []
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            deleteOption: 'Delete'
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        // Fără storageUri = storage gestionat de Azure.
        enabled: true
      }
    }
  }
}

output name string = vm.name
output privateIp string = privateIp
output principalId string = vm.identity.principalId
