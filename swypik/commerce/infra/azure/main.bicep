// ============================================================================
// Swypik — infrastructură Azure pe roluri (Microsoft for Startups credits)
// ============================================================================
// Scope: resource group. Creează:
//   - VNet cu 3 subneturi (web / data / worker), câte un NSG pe subnet,
//     deny-all inbound + doar fluxurile interne necesare;
//   - NAT Gateway (ieșire pentru toate VM-urile; niciun VM nu are IP public,
//     cu excepția opțională a jump host-ului web-1 pentru SSH admin);
//   - N VM-uri `web` identice (web-next + platform-api + cloudflared; web-1
//     rulează și cron-worker), 1 VM `data` (Postgres 16 pgvector + Redis,
//     disc Premium SSD, fără IP public),
//     M VM-uri `worker` (video-worker care consumă coada Redis; opțional Spot);
//   - buget lunar pe RG cu alerte.
// Totul rulează în Docker Compose (infra/azure/compose/*.yml) — portabil 1:1
// pe Hetzner (vezi docs/infra/scaling.md). Niciun serviciu gestionat Azure în
// calea critică.
//
// Deploy (DOAR de owner, după `az login` + `az account set -s <subscription>`):
//   az group create -n rg-swypik-prod -l polandcentral --tags app=swypik env=prod
//   az deployment group what-if -g rg-swypik-prod \
//     -f infra/azure/main.bicep -p infra/azure/main.parameters.json
//   az deployment group create -g rg-swypik-prod -n swypik-infra \
//     -f infra/azure/main.bicep -p infra/azure/main.parameters.json
// Detalii + pașii de după: docs/infra/azure-cutover.md.
// Fără secrete: cheile SSH sunt publice; tokenul tunelului și fișierele .env
// se pun pe VM-uri la runtime (docs/infra/azure-cutover.md).
// ============================================================================

targetScope = 'resourceGroup'

@description('Regiunea. Implicit Poland Central (cea mai apropiată de RO); fallback germanywestcentral dacă SKU-urile nu au cotă/capacitate.')
@allowed([
  'polandcentral'
  'germanywestcentral'
  'swedencentral'
  'northeurope'
  'westeurope'
])
param location string = 'swedencentral'

@description('Prefix pentru numele resurselor.')
@minLength(3)
@maxLength(16)
param namePrefix string = 'swypik-prod'

// ── roluri ──────────────────────────────────────────────────────────────────
@description('Numărul de VM-uri web identice (stateless). Minim 2 pentru rolling deploy fără downtime.')
@minValue(1)
@maxValue(10)
param webCount int = 2

@description('Zona de disponibilitate pentru toate VM-urile și discul de date. În polandcentral seria v7 e disponibilă abonamentului doar în zona 3 (verificat 2026-09-26 cu az vm list-skus).')
@allowed([
  '1'
  '2'
  '3'
])
param availabilityZone string = '1'

@description('Controlerul de discuri: v6/v7 cer NVMe; v5 folosește SCSI.')
@allowed([
  'NVMe'
  'SCSI'
])
param diskControllerType string = 'NVMe'

@description('Dimensiunea VM-urilor web. D2as_v7 = 2 vCPU/8 GiB (AMD EPYC generația cea mai nouă, NVMe).')
param webVmSize string = 'Standard_D2as_v7'

@description('Dimensiunea VM-ului data (Postgres + Redis). E2as_v7 = 2 vCPU/16 GiB; E4as_v7 (4/32) la creștere — resize = câteva minute de oprire.')
param dataVmSize string = 'Standard_E2as_v7'

@description('Discul Premium SSD v2 al VM-ului data (GiB). IOPS/MB/s se setează separat de mărime.')
@minValue(64)
param dataDiskSizeGB int = 256

@description('IOPS provizionate pe discul de date (Premium SSD v2: 3000 incluse gratuit).')
@minValue(3000)
param dataDiskIops int = 3000

@description('Debit provizionat pe discul de date în MB/s (Premium SSD v2: 125 incluse gratuit).')
@minValue(125)
param dataDiskMBps int = 125

@description('Numărul de VM-uri worker (video). 0 = fără worker dedicat.')
@minValue(0)
@maxValue(10)
param workerCount int = 1

@description('Dimensiunea VM-urilor worker. D2as_v7 = 2 vCPU/8 GiB; D4as_v7 (4/16) dacă coada de transcodare crește.')
param workerVmSize string = 'Standard_D2as_v7'

@description('Worker-ele ca VM Spot (ieftin, evacuabil). Implicit NU: abonamentul are cotă Spot de doar 3 vCPU.')
param workerUseSpot bool = false

// ── acces ───────────────────────────────────────────────────────────────────
@description('Userul administrativ Azure (sudo) pe toate VM-urile.')
param adminUsername string = 'swypikadmin'

@description('Cheia publică SSH a administratorului (ssh-ed25519 ...). Parolele sunt dezactivate.')
param adminSshPublicKey string

@description('Cheia publică SSH internă de deploy (ssh-ed25519 ...) pusă la userul `dev` pe toate VM-urile; cheia privată stă doar pe web-1 (/home/dev/.ssh/swypik_deploy).')
param deploySshPublicKey string

@description('CIDR admin pentru SSH pe web-1 (jump host, ex. "203.0.113.10/32"). Gol = fără IP public; acces doar prin `az vm run-command`.')
param sshAllowedSourceCidr string = ''

// ── rețea ───────────────────────────────────────────────────────────────────
param vnetAddressPrefix string = '10.60.0.0/16'
param webSubnetPrefix string = '10.60.1.0/24'
param dataSubnetPrefix string = '10.60.2.0/24'
param workerSubnetPrefix string = '10.60.3.0/24'

@description('Primele 3 octeți ai subnetului web; web-N primește .(10+N-1).')
param webIpBase string = '10.60.1'
@description('IP-ul privat static al VM-ului data (DATABASE_URL / REDIS_URL îl folosesc).')
param dataPrivateIp string = '10.60.2.10'
@description('Primele 3 octeți ai subnetului worker; worker-N primește .(10+N-1).')
param workerIpBase string = '10.60.3'

@allowed([
  'Premium_LRS'
  'StandardSSD_LRS'
])
param osDiskType string = 'StandardSSD_LRS'
param osDiskSizeGB int = 64

// ── cost ────────────────────────────────────────────────────────────────────
@description('Bugetul lunar pe RG (moneda abonamentului, USD). Ținta 250–400; alertele sunt doar notificări.')
@minValue(10)
param monthlyBudgetAmount int = 400

@description('Emailuri pentru alertele de buget.')
@minLength(1)
param budgetContactEmails array

@description('Prima zi a lunii de start, yyyy-MM-01 (ex. 2026-10-01).')
param budgetStartDate string

param tags object = {
  app: 'swypik'
  env: 'prod'
  owner: 'swypik'
  costCenter: 'ms-startups-credits'
  managedBy: 'bicep'
}

var cloudInitTemplate = loadTextContent('cloud-init.yaml')
var hasAdminSsh = !empty(sshAllowedSourceCidr)

// ── NSG-uri ─────────────────────────────────────────────────────────────────
var denyAll = {
  name: 'Deny-All-Inbound'
  properties: {
    // Suprascrie regulile implicite AllowVnetInBound/AllowAzureLoadBalancerInBound.
    priority: 4000
    direction: 'Inbound'
    access: 'Deny'
    protocol: '*'
    sourceAddressPrefix: '*'
    sourcePortRange: '*'
    destinationAddressPrefix: '*'
    destinationPortRange: '*'
  }
}

var sshFromWeb = {
  name: 'Allow-SSH-From-Web-Subnet'
  properties: {
    // web-1 (control node) orchestrează deploy-ul prin SSH pe rețeaua privată.
    priority: 200
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: webSubnetPrefix
    sourcePortRange: '*'
    destinationAddressPrefix: '*'
    destinationPortRange: '22'
  }
}

var adminSshRule = [
  {
    name: 'Allow-SSH-From-Admin'
    properties: {
      priority: 100
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: sshAllowedSourceCidr
      sourcePortRange: '*'
      destinationAddressPrefix: '${webIpBase}.10'
      destinationPortRange: '22'
    }
  }
]

var webRules = concat(hasAdminSsh ? adminSshRule : [], [
  sshFromWeb
  denyAll
])

var dataRules = [
  {
    name: 'Allow-DB-Redis-From-Web'
    properties: {
      priority: 100
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: webSubnetPrefix
      sourcePortRange: '*'
      destinationAddressPrefix: dataPrivateIp
      destinationPortRanges: [
        '5432'
        '6379'
        // MinIO temporar (profil interim-media) până se activează R2
        '9000'
      ]
    }
  }
  {
    name: 'Allow-DB-Redis-From-Worker'
    properties: {
      priority: 110
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: workerSubnetPrefix
      sourcePortRange: '*'
      destinationAddressPrefix: dataPrivateIp
      destinationPortRanges: [
        '5432'
        '6379'
        '9000'
      ]
    }
  }
  sshFromWeb
  denyAll
]

var workerRules = [
  sshFromWeb
  denyAll
]

resource nsgWeb 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${namePrefix}-nsg-web'
  location: location
  tags: tags
  properties: {
    securityRules: webRules
  }
}

resource nsgData 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${namePrefix}-nsg-data'
  location: location
  tags: tags
  properties: {
    securityRules: dataRules
  }
}

resource nsgWorker 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${namePrefix}-nsg-worker'
  location: location
  tags: tags
  properties: {
    securityRules: workerRules
  }
}

// ── ieșire: NAT Gateway (niciun VM nu are nevoie de IP public) ─────────────
resource natPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${namePrefix}-nat-pip'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: '${namePrefix}-nat'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [
      {
        id: natPip.id
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${namePrefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: 'snet-web'
        properties: {
          addressPrefix: webSubnetPrefix
          networkSecurityGroup: { id: nsgWeb.id }
          natGateway: { id: nat.id }
          defaultOutboundAccess: false
        }
      }
      {
        name: 'snet-data'
        properties: {
          addressPrefix: dataSubnetPrefix
          networkSecurityGroup: { id: nsgData.id }
          natGateway: { id: nat.id }
          defaultOutboundAccess: false
        }
      }
      {
        name: 'snet-worker'
        properties: {
          addressPrefix: workerSubnetPrefix
          networkSecurityGroup: { id: nsgWorker.id }
          natGateway: { id: nat.id }
          defaultOutboundAccess: false
        }
      }
    ]
  }
}

// Jump host opțional: IP public doar pe web-1, SSH doar din CIDR-ul admin.
resource jumpPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (hasAdminSsh) {
  name: '${namePrefix}-web-1-pip'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

func roleCloudInit(template string, role string, deployKey string) string =>
  replace(replace(template, '__SWYPIK_ROLE__', role), '__DEV_AUTHORIZED_KEY__', deployKey)

// ── VM-uri ──────────────────────────────────────────────────────────────────
module data 'modules/vm.bicep' = {
  name: 'vm-data'
  params: {
    name: '${namePrefix}-data'
    location: location
    tags: tags
    role: 'data'
    vmSize: dataVmSize
    subnetId: '${vnet.id}/subnets/snet-data'
    privateIp: dataPrivateIp
    adminUsername: adminUsername
    adminSshPublicKey: adminSshPublicKey
    zone: availabilityZone
    diskControllerType: diskControllerType
    customData: roleCloudInit(cloudInitTemplate, 'data', deploySshPublicKey)
    osDiskType: 'Premium_LRS'
    osDiskSizeGB: 32
    dataDiskSizeGB: dataDiskSizeGB
    dataDiskIops: dataDiskIops
    dataDiskMBps: dataDiskMBps
  }
}

module web 'modules/vm.bicep' = [for i in range(1, webCount): {
  name: 'vm-web-${i}'
  params: {
    name: '${namePrefix}-web-${i}'
    location: location
    tags: tags
    role: 'web'
    vmSize: webVmSize
    subnetId: '${vnet.id}/subnets/snet-web'
    privateIp: '${webIpBase}.${9 + i}'
    publicIpId: (i == 1 && hasAdminSsh) ? jumpPip.id : ''
    adminUsername: adminUsername
    adminSshPublicKey: adminSshPublicKey
    zone: availabilityZone
    diskControllerType: diskControllerType
    customData: roleCloudInit(cloudInitTemplate, 'web', deploySshPublicKey)
    osDiskType: osDiskType
    osDiskSizeGB: osDiskSizeGB
  }
}]

module worker 'modules/vm.bicep' = [for i in range(1, workerCount): {
  name: 'vm-worker-${i}'
  params: {
    name: '${namePrefix}-worker-${i}'
    location: location
    tags: tags
    role: 'worker'
    vmSize: workerVmSize
    subnetId: '${vnet.id}/subnets/snet-worker'
    privateIp: '${workerIpBase}.${9 + i}'
    adminUsername: adminUsername
    adminSshPublicKey: adminSshPublicKey
    zone: availabilityZone
    diskControllerType: diskControllerType
    customData: roleCloudInit(cloudInitTemplate, 'worker', deploySshPublicKey)
    osDiskType: osDiskType
    osDiskSizeGB: osDiskSizeGB
    useSpot: workerUseSpot
  }
}]

// ── buget ───────────────────────────────────────────────────────────────────
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${namePrefix}-monthly-budget'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      actual50: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: budgetContactEmails
      }
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: budgetContactEmails
      }
      actual100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: budgetContactEmails
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: budgetContactEmails
      }
    }
  }
}

// ── ieșiri (→ /opt/swypik/env/hosts.env pe web-1) ───────────────────────────
output webPrivateIps array = [for i in range(0, webCount): web[i].outputs.privateIp]
output dataPrivateIp string = data.outputs.privateIp
output workerPrivateIps array = [for i in range(0, workerCount): worker[i].outputs.privateIp]
output natEgressIp string = natPip.properties.ipAddress
output jumpHostPublicIp string = hasAdminSsh ? jumpPip!.properties.ipAddress : ''
