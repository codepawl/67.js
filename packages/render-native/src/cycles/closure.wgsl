/* SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
 * SPDX-FileCopyrightText: 2011-2026 Blender Foundation
 *
 * SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
 *
 * Adapted code from Open Shading Language and Blender Cycles
 * (kernel/svm/closure.h, kernel/closure/bsdf.h, kernel/closure/bsdf_sheen.h). */

const CLOSURE_WEIGHT_CUTOFF: f32 = 1e-5;
const CLOSURE_SINGULAR_WEIGHT: f32 = 1e6;
const CLOSURE_PCG_INV_24: f32 = 5.960464477539063e-8;

fn closure_lut_sheen_u32(word_idx: u32) -> u32 {
  let vec_idx = word_idx >> 2u;
  let lane = word_idx & 3u;
  var v = vec4<u32>(0u);
  switch (vec_idx >> 6u) {
    case 0u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x0000233fu, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 3u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x247524f8u, 0x2ea329e7u, 0x33a82bfeu, 0x00000000u); }
        case 5u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 7u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x24da24efu, 0x290227afu, 0x2ab52a52u, 0x2c2c2bb4u); }
        case 9u: { v = vec4<u32>(0x32c02d48u, 0x32173017u, 0x314f30e2u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 11u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x28d127e5u, 0x293d290fu, 0x2a6b29adu, 0x2bf52b21u); }
        case 13u: { v = vec4<u32>(0x2d0f2c43u, 0x2ee82e77u, 0x300a2eceu, 0x30ea3075u); }
        case 14u: { v = vec4<u32>(0x30ab3128u, 0x333d3476u, 0x3278320fu, 0x362434d8u); }
        case 15u: { v = vec4<u32>(0x3769363fu, 0x00003725u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x2a982945u, 0x2b812b54u, 0x2bdf2b9eu, 0x2c7c2c20u); }
        case 17u: { v = vec4<u32>(0x2d862cfau, 0x2ec72e2au, 0x2fd02edcu, 0x3062304bu); }
        case 18u: { v = vec4<u32>(0x30d730e5u, 0x324031a6u, 0x325332aau, 0x354733bfu); }
        case 19u: { v = vec4<u32>(0x365634f0u, 0x36cd3623u, 0x36cd36a8u, 0x377135e0u); }
        case 20u: { v = vec4<u32>(0x2c272a83u, 0x2d552cedu, 0x2dba2d8au, 0x2e372deeu); }
        case 21u: { v = vec4<u32>(0x2efc2e79u, 0x2ff42f6au, 0x30543028u, 0x30da30d0u); }
        case 22u: { v = vec4<u32>(0x31553113u, 0x31c431c7u, 0x32c0325eu, 0x33a332ffu); }
        case 23u: { v = vec4<u32>(0x34623410u, 0x34aa3492u, 0x355a34b0u, 0x363335d8u); }
        case 24u: { v = vec4<u32>(0x2cef2bc0u, 0x2efd2e20u, 0x2ffb2f8fu, 0x304a3026u); }
        case 25u: { v = vec4<u32>(0x3095306bu, 0x30ea30bcu, 0x3157311au, 0x31bf319eu); }
        case 26u: { v = vec4<u32>(0x322c31d9u, 0x32a9326du, 0x335132eeu, 0x33ea33a7u); }
        case 27u: { v = vec4<u32>(0x344b3440u, 0x34e5349au, 0x35a634ffu, 0x35ef35b1u); }
        case 28u: { v = vec4<u32>(0x2dbe2c87u, 0x303d2f3cu, 0x310b30b5u, 0x3186314fu); }
        case 29u: { v = vec4<u32>(0x31d631b1u, 0x321d31fcu, 0x3274324au, 0x32c532a2u); }
        case 30u: { v = vec4<u32>(0x333632f1u, 0x3397336fu, 0x340633c6u, 0x344e3431u); }
        case 31u: { v = vec4<u32>(0x34a1347du, 0x350d34dfu, 0x359d3554u, 0x361335f5u); }
        case 32u: { v = vec4<u32>(0x2ea72d43u, 0x30ea302cu, 0x31f53185u, 0x3290324bu); }
        case 33u: { v = vec4<u32>(0x32f432c9u, 0x3344331eu, 0x338b336au, 0x33ce33abu); }
        case 34u: { v = vec4<u32>(0x341633f6u, 0x344c342bu, 0x347e3462u, 0x34c134a4u); }
        case 35u: { v = vec4<u32>(0x350b34e4u, 0x356a353cu, 0x35e635abu, 0x365a362cu); }
        case 36u: { v = vec4<u32>(0x2fa92e24u, 0x318d30bcu, 0x32c3323cu, 0x33773328u); }
        case 37u: { v = vec4<u32>(0x33ef33b7u, 0x3424340fu, 0x344b3436u, 0x3473345eu); }
        case 38u: { v = vec4<u32>(0x34993483u, 0x34c134adu, 0x34f034d7u, 0x35313510u); }
        case 39u: { v = vec4<u32>(0x35713554u, 0x35cd359du, 0x363d35ffu, 0x36ad3677u); }
        case 40u: { v = vec4<u32>(0x30622f27u, 0x32323160u, 0x337f32e7u, 0x342933f8u); }
        case 41u: { v = vec4<u32>(0x346d344du, 0x34a13488u, 0x34ca34b6u, 0x34f334dfu); }
        case 42u: { v = vec4<u32>(0x35193507u, 0x3543352cu, 0x3574355bu, 0x35a8358eu); }
        case 43u: { v = vec4<u32>(0x35e635c6u, 0x362d3600u, 0x36933656u, 0x370936c6u); }
        case 44u: { v = vec4<u32>(0x3102301eu, 0x32d93208u, 0x341b3390u, 0x3492345du); }
        case 45u: { v = vec4<u32>(0x34de34bbu, 0x351734fcu, 0x35453530u, 0x356e355bu); }
        case 46u: { v = vec4<u32>(0x35953583u, 0x35bd35abu, 0x35ea35d5u, 0x361f3608u); }
        case 47u: { v = vec4<u32>(0x365c363fu, 0x36973678u, 0x36e436beu, 0x375d3725u); }
        case 48u: { v = vec4<u32>(0x31b430b4u, 0x338632b8u, 0x34753421u, 0x34f634bbu); }
        case 49u: { v = vec4<u32>(0x354a3524u, 0x3587356bu, 0x35bb35a2u, 0x35e735d2u); }
        case 50u: { v = vec4<u32>(0x361135fdu, 0x36393624u, 0x3664364cu, 0x3695367cu); }
        case 51u: { v = vec4<u32>(0x36d036b1u, 0x370e36efu, 0x3755372fu, 0x37bc3789u); }
        case 52u: { v = vec4<u32>(0x3272315du, 0x3420336cu, 0x34d2347fu, 0x3557351au); }
        case 53u: { v = vec4<u32>(0x35b5358bu, 0x35f735d9u, 0x362c3613u, 0x365c3644u); }
        case 54u: { v = vec4<u32>(0x36873672u, 0x36b1369cu, 0x36dc36c6u, 0x370b36f4u); }
        case 55u: { v = vec4<u32>(0x37403724u, 0x377e375fu, 0x37c637a2u, 0x381037f5u); }
        case 56u: { v = vec4<u32>(0x3331321du, 0x34823417u, 0x353534e1u, 0x35bc357eu); }
        case 57u: { v = vec4<u32>(0x361f35f2u, 0x36673646u, 0x369f3684u, 0x36d036b8u); }
        case 58u: { v = vec4<u32>(0x36fd36e7u, 0x37283713u, 0x3753373eu, 0x3781376au); }
        case 59u: { v = vec4<u32>(0x37b5379au, 0x37ed37d0u, 0x38183807u, 0x3841382cu); }
        case 60u: { v = vec4<u32>(0x33f932eau, 0x34ea347eu, 0x359e3549u, 0x362735e7u); }
        case 61u: { v = vec4<u32>(0x368c365cu, 0x36d936b5u, 0x371536f8u, 0x3747372fu); }
        case 62u: { v = vec4<u32>(0x3774375fu, 0x37a1378bu, 0x37cc37b7u, 0x37f937e2u); }
        case 63u: { v = vec4<u32>(0x38153808u, 0x38303822u, 0x384e383eu, 0x3871385eu); }
        default: {}
      }
    }
    case 1u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x346533bbu, 0x355834ebu, 0x360b35b6u, 0x36963655u); }
        case 1u: { v = vec4<u32>(0x36ff36ceu, 0x374d3728u, 0x378d376fu, 0x37c137a8u); }
        case 2u: { v = vec4<u32>(0x37f137d9u, 0x380e3803u, 0x38233819u, 0x383a382eu); }
        case 3u: { v = vec4<u32>(0x38513844u, 0x3869385cu, 0x38843876u, 0x38a43894u); }
        case 4u: { v = vec4<u32>(0x34d43449u, 0x35cc355eu, 0x367e362bu, 0x370936c8u); }
        case 5u: { v = vec4<u32>(0x37753742u, 0x37c737a0u, 0x380437e9u, 0x381f3812u); }
        case 6u: { v = vec4<u32>(0x3837382bu, 0x384d3842u, 0x38623858u, 0x3878386du); }
        case 7u: { v = vec4<u32>(0x388c3882u, 0x38a33898u, 0x38bd38b0u, 0x38d938cau); }
        case 8u: { v = vec4<u32>(0x354934bau, 0x364435d6u, 0x36f536a3u, 0x3780373eu); }
        case 9u: { v = vec4<u32>(0x37ed37b9u, 0x3821380du, 0x38433833u, 0x385f3852u); }
        case 10u: { v = vec4<u32>(0x3877386bu, 0x388d3882u, 0x38a23898u, 0x38b638acu); }
        case 11u: { v = vec4<u32>(0x38ca38c0u, 0x38de38d4u, 0x38f438e9u, 0x390d38ffu); }
        case 12u: { v = vec4<u32>(0x35c43533u, 0x36c13652u, 0x3771371fu, 0x37f937b9u); }
        case 13u: { v = vec4<u32>(0x38333819u, 0x385e384au, 0x38813871u, 0x389e3890u); }
        case 14u: { v = vec4<u32>(0x38b738abu, 0x38cc38c2u, 0x38e138d7u, 0x38f538ebu); }
        case 15u: { v = vec4<u32>(0x390738feu, 0x391a390fu, 0x392b3923u, 0x39413935u); }
        case 16u: { v = vec4<u32>(0x364435b2u, 0x374536d4u, 0x37f237a2u, 0x383b381cu); }
        case 17u: { v = vec4<u32>(0x386f3857u, 0x389a3886u, 0x38bd38adu, 0x38da38ccu); }
        case 18u: { v = vec4<u32>(0x38f438e8u, 0x390938ffu, 0x391e3914u, 0x39313927u); }
        case 19u: { v = vec4<u32>(0x3942393au, 0x3954394bu, 0x3963395cu, 0x3974396au); }
        case 20u: { v = vec4<u32>(0x36cb3638u, 0x37cd375du, 0x383c3815u, 0x387c385eu); }
        case 21u: { v = vec4<u32>(0x38ad3896u, 0x38d538c3u, 0x38f738e7u, 0x39143906u); }
        case 22u: { v = vec4<u32>(0x392d3921u, 0x39433938u, 0x3957394du, 0x39683960u); }
        case 23u: { v = vec4<u32>(0x39793971u, 0x39893981u, 0x39993991u, 0x39a5399fu); }
        case 24u: { v = vec4<u32>(0x375836c4u, 0x382c37e9u, 0x3881385au, 0x38be38a2u); }
        case 25u: { v = vec4<u32>(0x38ed38d7u, 0x39123901u, 0x39313923u, 0x394b393fu); }
        case 26u: { v = vec4<u32>(0x39633958u, 0x3977396du, 0x398a3981u, 0x399c3993u); }
        case 27u: { v = vec4<u32>(0x39ac39a4u, 0x39bb39b4u, 0x39c939c2u, 0x39d639d0u); }
        case 28u: { v = vec4<u32>(0x37e93757u, 0x3873383cu, 0x38c538a0u, 0x390038e5u); }
        case 29u: { v = vec4<u32>(0x392d3918u, 0x394f393fu, 0x396c395eu, 0x39843978u); }
        case 30u: { v = vec4<u32>(0x3999398eu, 0x39ab39a2u, 0x39bc39b4u, 0x39cc39c4u); }
        case 31u: { v = vec4<u32>(0x39da39d3u, 0x39e839e1u, 0x39f539efu, 0x3a0239fbu); }
        case 32u: { v = vec4<u32>(0x383e37eeu, 0x38ba3885u, 0x390938e5u, 0x39413927u); }
        case 33u: { v = vec4<u32>(0x396a3957u, 0x398b397cu, 0x39a53998u, 0x39bb39b0u); }
        case 34u: { v = vec4<u32>(0x39cd39c4u, 0x39de39d6u, 0x39ed39e6u, 0x39fb39f4u); }
        case 35u: { v = vec4<u32>(0x3a083a01u, 0x3a143a0eu, 0x3a1f3a1au, 0x3a2b3a25u); }
        case 36u: { v = vec4<u32>(0x38873843u, 0x38fe38cbu, 0x39493928u, 0x397f3966u); }
        case 37u: { v = vec4<u32>(0x39a63994u, 0x39c339b6u, 0x39db39d0u, 0x39ef39e6u); }
        case 38u: { v = vec4<u32>(0x3a0039f8u, 0x3a0f3a07u, 0x3a1c3a16u, 0x3a283a22u); }
        case 39u: { v = vec4<u32>(0x3a333a2eu, 0x3a3e3a39u, 0x3a473a43u, 0x3a523a4du); }
        case 40u: { v = vec4<u32>(0x38cf388eu, 0x39413910u, 0x39873967u, 0x39b939a2u); }
        case 41u: { v = vec4<u32>(0x39de39cdu, 0x39f939ecu, 0x3a0f3a05u, 0x3a213a19u); }
        case 42u: { v = vec4<u32>(0x3a303a29u, 0x3a3c3a36u, 0x3a483a42u, 0x3a523a4cu); }
        case 43u: { v = vec4<u32>(0x3a5c3a57u, 0x3a653a60u, 0x3a6e3a69u, 0x3a763a71u); }
        case 44u: { v = vec4<u32>(0x391338d6u, 0x397e3951u, 0x39c139a3u, 0x39f039dau); }
        case 45u: { v = vec4<u32>(0x3a123a02u, 0x3a2b3a1fu, 0x3a3e3a35u, 0x3a4f3a47u); }
        case 46u: { v = vec4<u32>(0x3a5c3a55u, 0x3a673a62u, 0x3a713a6cu, 0x3a7a3a76u); }
        case 47u: { v = vec4<u32>(0x3a803a7eu, 0x3a893a85u, 0x3a913a8du, 0x3a973a94u); }
        case 48u: { v = vec4<u32>(0x3954391au, 0x39b8398du, 0x39f739dbu, 0x3a223a0fu); }
        case 49u: { v = vec4<u32>(0x3a413a33u, 0x3a593a4eu, 0x3a6a3a62u, 0x3a793a72u); }
        case 50u: { v = vec4<u32>(0x3a853a7fu, 0x3a8f3a8au, 0x3a973a93u, 0x3a9f3a9cu); }
        case 51u: { v = vec4<u32>(0x3aa53aa2u, 0x3aaa3aa8u, 0x3ab13aaeu, 0x3ab73ab4u); }
        case 52u: { v = vec4<u32>(0x398f395au, 0x39ed39c5u, 0x3a283a0eu, 0x3a503a3eu); }
        case 53u: { v = vec4<u32>(0x3a6d3a60u, 0x3a833a79u, 0x3a933a8bu, 0x3aa13a9au); }
        case 54u: { v = vec4<u32>(0x3aaa3aa6u, 0x3ab33aafu, 0x3aba3ab8u, 0x3ac13abdu); }
        case 55u: { v = vec4<u32>(0x3ac63ac3u, 0x3acb3ac8u, 0x3ace3acdu, 0x3ad43ad2u); }
        case 56u: { v = vec4<u32>(0x39c63994u, 0x3a1e39f8u, 0x3a553a3cu, 0x3a7b3a6au); }
        case 57u: { v = vec4<u32>(0x3a953a8au, 0x3aa93a9fu, 0x3ab83ab1u, 0x3ac43abeu); }
        case 58u: { v = vec4<u32>(0x3acd3ac8u, 0x3ad53ad1u, 0x3ada3ad8u, 0x3ae03adeu); }
        case 59u: { v = vec4<u32>(0x3ae33ae2u, 0x3ae73ae5u, 0x3aeb3aeau, 0x3aef3aedu); }
        case 60u: { v = vec4<u32>(0x39f839cau, 0x3a4a3a27u, 0x3a7d3a66u, 0x3aa13a91u); }
        case 61u: { v = vec4<u32>(0x3aba3aaeu, 0x3acb3ac3u, 0x3ad93ad2u, 0x3ae43adfu); }
        case 62u: { v = vec4<u32>(0x3aec3ae8u, 0x3af33aefu, 0x3af93af6u, 0x3afd3afcu); }
        case 63u: { v = vec4<u32>(0x3b013affu, 0x3b043b03u, 0x3b073b04u, 0x3b093b09u); }
        default: {}
      }
    }
    case 2u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x000010eau, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 3u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x9df398c0u, 0x9f949fe0u, 0x98f5a642u, 0x00000000u); }
        case 5u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 7u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x9877a34au, 0x9bdd97f2u, 0xa1ab9ed7u, 0xa4139fa4u); }
        case 9u: { v = vec4<u32>(0xa3a8a163u, 0xa350a3d5u, 0xa54da288u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 11u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x9f45aa49u, 0x981e98d5u, 0x9d979a1au, 0xa1bda045u); }
        case 13u: { v = vec4<u32>(0xa455a2a0u, 0xa473a432u, 0xa4fca534u, 0xa773a607u); }
        case 14u: { v = vec4<u32>(0xa76fa691u, 0xa7cba7d9u, 0xa821a92du, 0xa7bda868u); }
        case 15u: { v = vec4<u32>(0xa52da89fu, 0x0000a6a1u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0xa719aed4u, 0x9c509f58u, 0x9c169b30u, 0x9eec9d58u); }
        case 17u: { v = vec4<u32>(0xa1a0a06fu, 0xa412a2d2u, 0xa53aa46au, 0xa668a5bau); }
        case 18u: { v = vec4<u32>(0xa72da6d2u, 0xa807a815u, 0xa873a848u, 0xa800a86fu); }
        case 19u: { v = vec4<u32>(0xa7b4a83au, 0xa672a818u, 0xa445a817u, 0x9c09a7a0u); }
        case 20u: { v = vec4<u32>(0xab1bb11fu, 0xa0c6a286u, 0x9d319df6u, 0x9e4f9d70u); }
        case 21u: { v = vec4<u32>(0xa0dca00eu, 0xa347a1fau, 0xa4c2a430u, 0xa646a5bau); }
        case 22u: { v = vec4<u32>(0xa807a6f3u, 0xa838a840u, 0xa84fa878u, 0xa908a8c7u); }
        case 23u: { v = vec4<u32>(0xa895a8f7u, 0xa89da93cu, 0xa893a8f2u, 0x1514a6b6u); }
        case 24u: { v = vec4<u32>(0xadadb1cdu, 0xa374a72bu, 0xa0a1a163u, 0xa099a06cu); }
        case 25u: { v = vec4<u32>(0xa1afa138u, 0xa422a2efu, 0xa56ba4ecu, 0xa6aca60du); }
        case 26u: { v = vec4<u32>(0xa830a764u, 0xa89ea878u, 0xa8e6a8c1u, 0xa904a8e8u); }
        case 27u: { v = vec4<u32>(0xa99ca936u, 0xa8b9a8f1u, 0xa804a929u, 0x99c1a60eu); }
        case 28u: { v = vec4<u32>(0xaeeab1c6u, 0xa631aa59u, 0xa2d3a42eu, 0xa207a22au); }
        case 29u: { v = vec4<u32>(0xa293a222u, 0xa406a335u, 0xa53aa498u, 0xa671a5b9u); }
        case 30u: { v = vec4<u32>(0xa80ea739u, 0xa8eaa8a6u, 0xa9f2a927u, 0xa9f2a9adu); }
        case 31u: { v = vec4<u32>(0xaa69a998u, 0xaa0aaa28u, 0xa887a959u, 0x1804a6beu); }
        case 32u: { v = vec4<u32>(0xb034b19cu, 0xa934ad2eu, 0xa4c6a639u, 0xa3aba426u); }
        case 33u: { v = vec4<u32>(0xa39da37au, 0xa443a3eeu, 0xa515a49du, 0xa635a598u); }
        case 34u: { v = vec4<u32>(0xa75aa6c0u, 0xa86ca803u, 0xa908a8beu, 0xaa24a9d2u); }
        case 35u: { v = vec4<u32>(0xaa47aa63u, 0xa9c1aa33u, 0xa906a984u, 0x1438a6efu); }
        case 36u: { v = vec4<u32>(0xb0cdb191u, 0xac05aea7u, 0xa6d4a8bcu, 0xa506a599u); }
        case 37u: { v = vec4<u32>(0xa4a2a4bfu, 0xa4d1a4afu, 0xa562a518u, 0xa635a5beu); }
        case 38u: { v = vec4<u32>(0xa731a6afu, 0xa81ca7ccu, 0xa8b1a85eu, 0xa950a8f8u); }
        case 39u: { v = vec4<u32>(0xa99aa989u, 0xa9e0a9e0u, 0xa8f1a961u, 0x0c19a7ccu); }
        case 40u: { v = vec4<u32>(0xb131b1a9u, 0xad9eafbau, 0xa8f8ab5bu, 0xa6b5a7cbu); }
        case 41u: { v = vec4<u32>(0xa5dda62du, 0xa5b9a5c1u, 0xa603a5d8u, 0xa68fa642u); }
        case 42u: { v = vec4<u32>(0xa752a6fau, 0xa818a7cdu, 0xa8a2a860u, 0xa905a8d4u); }
        case 43u: { v = vec4<u32>(0xa94ca936u, 0xa948a934u, 0xa8d1a903u, 0x0a8ea791u); }
        case 44u: { v = vec4<u32>(0xb16ab1bfu, 0xaef2b05du, 0xab40ad3au, 0xa882a973u); }
        case 45u: { v = vec4<u32>(0xa769a7ffu, 0xa6e2a711u, 0xa6d5a6cbu, 0xa721a6f3u); }
        case 46u: { v = vec4<u32>(0xa7a6a75eu, 0xa82da804u, 0xa891a864u, 0xa8dba8cau); }
        case 47u: { v = vec4<u32>(0xa91fa910u, 0xa8faa923u, 0xa856a8c9u, 0x0843a732u); }
        case 48u: { v = vec4<u32>(0xb189b1bfu, 0xaff9b0bfu, 0xad10ae7bu, 0xaa09ab88u); }
        case 49u: { v = vec4<u32>(0xa8a8a92cu, 0xa827a85au, 0xa7f8a80du, 0xa803a7f2u); }
        case 50u: { v = vec4<u32>(0xa821a810u, 0xa85ca83bu, 0xa89aa880u, 0xa8e5a8c6u); }
        case 51u: { v = vec4<u32>(0xa912a901u, 0xa8f6a90eu, 0xa834a8abu, 0x8150a6cfu); }
        case 52u: { v = vec4<u32>(0xb19ab1b2u, 0xb05cb107u, 0xae40af6du, 0xac02ad13u); }
        case 53u: { v = vec4<u32>(0xa9e9aac1u, 0xa90fa966u, 0xa8b1a8d4u, 0xa88fa894u); }
        case 54u: { v = vec4<u32>(0xa887a885u, 0xa89ea894u, 0xa8c5a8aeu, 0xa8e7a8dau); }
        case 55u: { v = vec4<u32>(0xa8fda8eeu, 0xa8d1a8f9u, 0xa818a894u, 0x81f7a6dbu); }
        case 56u: { v = vec4<u32>(0xb1a4b19fu, 0xb0a0b132u, 0xaf25b014u, 0xad3eae30u); }
        case 57u: { v = vec4<u32>(0xab89ac5eu, 0xaa23aab5u, 0xa981a9c2u, 0xa92aa950u); }
        case 58u: { v = vec4<u32>(0xa90da917u, 0xa904a90cu, 0xa8faa8fau, 0xa8ffa901u); }
        case 59u: { v = vec4<u32>(0xa904a905u, 0xa8bda8e6u, 0xa7fba86fu, 0x8ae2a65du); }
        case 60u: { v = vec4<u32>(0xb1a2b18au, 0xb0cfb149u, 0xafc8b057u, 0xae30aef6u); }
        case 61u: { v = vec4<u32>(0xacbead69u, 0xab7cac23u, 0xaa75aae0u, 0xa9dfaa2cu); }
        case 62u: { v = vec4<u32>(0xa9a6a9aeu, 0xa965a982u, 0xa94ea953u, 0xa929a932u); }
        case 63u: { v = vec4<u32>(0xa900a916u, 0xa8a8a8ddu, 0xa7c2a866u, 0x029fa662u); }
        default: {}
      }
    }
    case 3u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xb195b175u, 0xb0eab14eu, 0xb01eb084u, 0xaed9af83u); }
        case 1u: { v = vec4<u32>(0xada5ae3au, 0xac91ad16u, 0xab8eac17u, 0xaac0ab34u); }
        case 2u: { v = vec4<u32>(0xaa28aa6bu, 0xa9e9aa05u, 0xa9a2a9b9u, 0xa94da97cu); }
        case 3u: { v = vec4<u32>(0xa905a93au, 0xa8aba8eeu, 0xa79fa84eu, 0x0843a5c7u); }
        case 4u: { v = vec4<u32>(0xb17bb15au, 0xb0f4b147u, 0xb043b09bu, 0xaf4bafe2u); }
        case 5u: { v = vec4<u32>(0xae3eaec1u, 0xad50adc2u, 0xac7dace7u, 0xabc8ac1eu); }
        case 6u: { v = vec4<u32>(0xab07ab5cu, 0xaa6caab4u, 0xa9efaa19u, 0xa985a9b3u); }
        case 7u: { v = vec4<u32>(0xa932a95cu, 0xa8a9a8e6u, 0xa743a837u, 0x0896a597u); }
        case 8u: { v = vec4<u32>(0xb15bb138u, 0xb0f1b135u, 0xb057b0a3u, 0xaf92b00eu); }
        case 9u: { v = vec4<u32>(0xaea2af17u, 0xadd1ae36u, 0xad12ad71u, 0xac78acbbu); }
        case 10u: { v = vec4<u32>(0xabd2ac37u, 0xab1eab88u, 0xaa5eaaadu, 0xa9cbaa11u); }
        case 11u: { v = vec4<u32>(0xa947a995u, 0xa8a4a8f4u, 0xa74ea82fu, 0x0843a57eu); }
        case 12u: { v = vec4<u32>(0xb132b10eu, 0xb0e0b118u, 0xb059b09du, 0xafb8b019u); }
        case 13u: { v = vec4<u32>(0xaedcaf47u, 0xae1eae7au, 0xad79adcau, 0xace4ad2bu); }
        case 14u: { v = vec4<u32>(0xac5daca3u, 0xabe1ac2au, 0xaae8ab53u, 0xaa19aa7eu); }
        case 15u: { v = vec4<u32>(0xa96ea9c6u, 0xa8a7a92fu, 0xa72aa81eu, 0x8150a556u); }
        case 16u: { v = vec4<u32>(0xb103b0dfu, 0xb0beb0efu, 0xb04cb086u, 0xafb9b012u); }
        case 17u: { v = vec4<u32>(0xaeefaf4fu, 0xae47ae97u, 0xadb0adf8u, 0xad26ad6au); }
        case 18u: { v = vec4<u32>(0xaca8ace5u, 0xac36ac6du, 0xab84abfbu, 0xaaa2ab14u); }
        case 19u: { v = vec4<u32>(0xa9cbaa2cu, 0xa8cca953u, 0xa723a830u, 0x0150a54du); }
        case 20u: { v = vec4<u32>(0xb0c8b0a8u, 0xb090b0b9u, 0xb02db060u, 0xaf95aff2u); }
        case 21u: { v = vec4<u32>(0xaee5af39u, 0xae4bae92u, 0xadbfae02u, 0xad40ad80u); }
        case 22u: { v = vec4<u32>(0xacc9ad06u, 0xac58ac91u, 0xabdaac23u, 0xab02ab6fu); }
        case 23u: { v = vec4<u32>(0xaa19aa89u, 0xa910a997u, 0xa734a85eu, 0x03efa529u); }
        case 24u: { v = vec4<u32>(0xb082b068u, 0xb054b076u, 0xaffdb02au, 0xaf50afa6u); }
        case 25u: { v = vec4<u32>(0xaeb3af02u, 0xae2bae6bu, 0xadafade8u, 0xad38ad74u); }
        case 26u: { v = vec4<u32>(0xaccdad05u, 0xac60ac97u, 0xabf1ac2cu, 0xab1cab86u); }
        case 27u: { v = vec4<u32>(0xaa2daaaau, 0xa91ba9abu, 0xa76da879u, 0x029fa552u); }
        case 28u: { v = vec4<u32>(0xb031b01bu, 0xb00ab027u, 0xaf7fafcbu, 0xaeeeaf37u); }
        case 29u: { v = vec4<u32>(0xae65aea9u, 0xadebae29u, 0xad7dadb6u, 0xad15ad49u); }
        case 30u: { v = vec4<u32>(0xacb0ace0u, 0xac4bac7eu, 0xabc8ac1au, 0xaafcab64u); }
        case 31u: { v = vec4<u32>(0xaa10aa8du, 0xa907a992u, 0xa748a865u, 0x03efa52eu); }
        case 32u: { v = vec4<u32>(0xafa7af86u, 0xaf64af95u, 0xaee8af28u, 0xae6eaeaau); }
        case 33u: { v = vec4<u32>(0xadfaae35u, 0xad92adc4u, 0xad32ad60u, 0xacd6ad02u); }
        case 34u: { v = vec4<u32>(0xac77aca6u, 0xac1cac48u, 0xab7eabd9u, 0xaab2ab17u); }
        case 35u: { v = vec4<u32>(0xa9d6aa43u, 0xa8c8a956u, 0xa6d1a82bu, 0x0347a4c6u); }
        case 36u: { v = vec4<u32>(0xaed0aeb7u, 0xae97aebeu, 0xae33ae67u, 0xadd0ae00u); }
        case 37u: { v = vec4<u32>(0xad75ada0u, 0xad1aad45u, 0xacc6acefu, 0xac77ac9fu); }
        case 38u: { v = vec4<u32>(0xac27ac4eu, 0xaba7abf9u, 0xaafeab52u, 0xaa43aaa1u); }
        case 39u: { v = vec4<u32>(0xa971a9dau, 0xa87ea901u, 0xa64aa7c9u, 0x03efa472u); }
        case 40u: { v = vec4<u32>(0xaddeadcfu, 0xadb2add1u, 0xad64ad8cu, 0xad16ad3bu); }
        case 41u: { v = vec4<u32>(0xaccbacefu, 0xac87aca8u, 0xac43ac65u, 0xac00ac21u); }
        case 42u: { v = vec4<u32>(0xab78abbdu, 0xaae6ab2fu, 0xaa4caa9bu, 0xa9a5a9f7u); }
        case 43u: { v = vec4<u32>(0xa8e9a94au, 0xa809a87bu, 0xa5b4a6f7u, 0x053ea3f4u); }
        case 44u: { v = vec4<u32>(0xacd3accau, 0xacb1acc9u, 0xac79ac96u, 0xac3fac5bu); }
        case 45u: { v = vec4<u32>(0xac08ac23u, 0xaba6abdcu, 0xab3dab72u, 0xaad5ab0au); }
        case 46u: { v = vec4<u32>(0xaa66aa9du, 0xa9f0aa2au, 0xa971a9b2u, 0xa8e1a92du); }
        case 47u: { v = vec4<u32>(0xa83ba892u, 0xa6efa7c2u, 0xa4f2a604u, 0x0150a301u); }
        case 48u: { v = vec4<u32>(0xab67ab5du, 0xab39ab58u, 0xaaedab14u, 0xaa9eaac5u); }
        case 49u: { v = vec4<u32>(0xaa52aa78u, 0xaa09aa2du, 0xa9bca9e5u, 0xa96fa996u); }
        case 50u: { v = vec4<u32>(0xa91ea949u, 0xa8c5a8f5u, 0xa864a895u, 0xa7e8a82fu); }
        case 51u: { v = vec4<u32>(0xa6e2a76bu, 0xa5a6a64eu, 0xa408a4eeu, 0x80a8a1c6u); }
        case 52u: { v = vec4<u32>(0xa904a8ffu, 0xa8e9a8fbu, 0xa8bda8d3u, 0xa88ea8a6u); }
        case 53u: { v = vec4<u32>(0xa861a877u, 0xa834a84bu, 0xa805a81du, 0xa7a9a7d9u); }
        case 54u: { v = vec4<u32>(0xa73da776u, 0xa6c8a707u, 0xa63fa689u, 0xa5a8a5f8u); }
        case 55u: { v = vec4<u32>(0xa4f7a551u, 0xa419a490u, 0xa1daa31eu, 0x0150a028u); }
        case 56u: { v = vec4<u32>(0xa512a50cu, 0xa4fba50au, 0xa4d5a4e8u, 0xa4b1a4c3u); }
        case 57u: { v = vec4<u32>(0xa487a49du, 0xa462a472u, 0xa436a44eu, 0xa40aa41fu); }
        case 58u: { v = vec4<u32>(0xa3aba3e0u, 0xa334a373u, 0xa2ada2f1u, 0xa216a268u); }
        case 59u: { v = vec4<u32>(0xa153a1bbu, 0xa063a0e1u, 0x9e4a9fb1u, 0x01509c6fu); }
        case 60u: { v = vec4<u32>(0x81500000u, 0x81500000u, 0x80a881f7u, 0x829f80a8u); }
        case 61u: { v = vec4<u32>(0x81f78150u, 0x81508347u, 0x80a88000u, 0x80a880a8u); }
        case 62u: { v = vec4<u32>(0x829f8347u, 0x81508150u, 0x01f780a8u, 0x01f70150u); }
        case 63u: { v = vec4<u32>(0x01f7029fu, 0x029f03efu, 0x03ef03efu, 0x01f705e6u); }
        default: {}
      }
    }
    case 4u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x000000a8u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 3u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x11d12b79u, 0x01500496u, 0x00000000u, 0x00000000u); }
        case 5u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 7u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x2e403637u, 0x1625217du, 0x07dd0e64u, 0x01f703efu); }
        case 9u: { v = vec4<u32>(0x01500150u, 0x00a800a8u, 0x00000000u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 11u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x34c6386eu, 0x28b52f86u, 0x19e62108u, 0x0f891423u); }
        case 13u: { v = vec4<u32>(0x08960b89u, 0x03ef068eu, 0x01f7029fu, 0x01500150u); }
        case 14u: { v = vec4<u32>(0x00a800a8u, 0x00a800a8u, 0x000000a8u, 0x00000000u); }
        case 15u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x36e13910u, 0x302c33fau, 0x26392b91u, 0x1c6f2106u); }
        case 17u: { v = vec4<u32>(0x144d1819u, 0x0e641114u, 0x09e60bddu, 0x05e60843u); }
        case 18u: { v = vec4<u32>(0x03ef053eu, 0x029f0347u, 0x015001f7u, 0x01500150u); }
        case 19u: { v = vec4<u32>(0x01500150u, 0x00a800a8u, 0x00a800a8u, 0x00a800a8u); }
        case 20u: { v = vec4<u32>(0x3810395du, 0x33203584u, 0x2cb83042u, 0x252328f3u); }
        case 21u: { v = vec4<u32>(0x1dd62149u, 0x18091aa3u, 0x128e14ffu, 0x0e8e10d5u); }
        case 22u: { v = vec4<u32>(0x0b350ceau, 0x084309e6u, 0x05e607ddu, 0x0496053eu); }
        case 23u: { v = vec4<u32>(0x034703efu, 0x01f7029fu, 0x015001f7u, 0x01500150u); }
        case 24u: { v = vec4<u32>(0x386e3980u, 0x34bd3691u, 0x304f328eu, 0x2a932d65u); }
        case 25u: { v = vec4<u32>(0x24c427deu, 0x1f3b21ccu, 0x1a3a1ca6u, 0x15f01857u); }
        case 26u: { v = vec4<u32>(0x1264142eu, 0x0f8910d5u, 0x0cea0de6u, 0x0a8e0c19u); }
        case 27u: { v = vec4<u32>(0x08430992u, 0x068e07ddu, 0x053e053eu, 0x03ef03efu); }
        case 28u: { v = vec4<u32>(0x38a9398fu, 0x35a7374fu, 0x32303442u, 0x2e03305eu); }
        case 29u: { v = vec4<u32>(0x295b2c08u, 0x24b9271fu, 0x206c2272u, 0x1c501e2fu); }
        case 30u: { v = vec4<u32>(0x18ab1a35u, 0x1549170cu, 0x1279140eu, 0x10431168u); }
        case 31u: { v = vec4<u32>(0x0d920f35u, 0x0bdd0cc0u, 0x0a3a0ae2u, 0x08430992u); }
        case 32u: { v = vec4<u32>(0x38cf3995u, 0x365e37dbu, 0x33e63515u, 0x30783203u); }
        case 33u: { v = vec4<u32>(0x2caf2e8au, 0x28cc2ab9u, 0x24e726e0u, 0x2119230au); }
        case 34u: { v = vec4<u32>(0x1da71f82u, 0x1a981c40u, 0x17f2190fu, 0x1529166eu); }
        case 35u: { v = vec4<u32>(0x12b8142eu, 0x10d511a7u, 0x0ee20fddu, 0x0cea0e10u); }
        case 36u: { v = vec4<u32>(0x38eb3997u, 0x36ee3822u, 0x34b235c2u, 0x31eb3384u); }
        case 37u: { v = vec4<u32>(0x2f043093u, 0x2c032d51u, 0x28882a00u, 0x252926d3u); }
        case 38u: { v = vec4<u32>(0x21f023c7u, 0x1efe208cu, 0x1c451d70u, 0x19881ad7u); }
        case 39u: { v = vec4<u32>(0x174a1881u, 0x150a1610u, 0x13211423u, 0x10ff11fbu); }
        case 40u: { v = vec4<u32>(0x38ff3996u, 0x3765384du, 0x35513651u, 0x33453470u); }
        case 41u: { v = vec4<u32>(0x30b731dfu, 0x2de72f7bu, 0x2b382c9fu, 0x286e29aau); }
        case 42u: { v = vec4<u32>(0x256926efu, 0x22b4243du, 0x20412154u, 0x1d781ecfu); }
        case 43u: { v = vec4<u32>(0x1b451c72u, 0x18f019e6u, 0x16f71819u, 0x150a15d1u); }
        case 44u: { v = vec4<u32>(0x390f3995u, 0x37c7386eu, 0x35e036c7u, 0x343f3504u); }
        case 45u: { v = vec4<u32>(0x31e43319u, 0x2fec30d8u, 0x2d372e77u, 0x2ac62c39u); }
        case 46u: { v = vec4<u32>(0x28632979u, 0x25b02718u, 0x237424a0u, 0x20f6221eu); }
        case 47u: { v = vec4<u32>(0x1eb02016u, 0x1c841d78u, 0x1a4a1b89u, 0x18961968u); }
        case 48u: { v = vec4<u32>(0x391a3992u, 0x380c388du, 0x3658372fu, 0x34cd358au); }
        case 49u: { v = vec4<u32>(0x3300341eu, 0x30fb31eeu, 0x2efa302fu, 0x2cce2dccu); }
        case 50u: { v = vec4<u32>(0x2a8b2bf1u, 0x286d2960u, 0x26082745u, 0x241b24fbu); }
        case 51u: { v = vec4<u32>(0x21b522d8u, 0x1fd820bcu, 0x1d7d1e8bu, 0x1bfd1cabu); }
        case 52u: { v = vec4<u32>(0x39253990u, 0x382f38a2u, 0x36bd3788u, 0x354835fdu); }
        case 53u: { v = vec4<u32>(0x340834a5u, 0x320132fcu, 0x30633122u, 0x2e562f73u); }
        case 54u: { v = vec4<u32>(0x2c832d5au, 0x2a632b9du, 0x2882295au, 0x265d279du); }
        case 55u: { v = vec4<u32>(0x24842556u, 0x225d23a0u, 0x20842163u, 0x1e881fceu); }
        case 56u: { v = vec4<u32>(0x392d3990u, 0x384c38b6u, 0x371a37d4u, 0x35bc3668u); }
        case 57u: { v = vec4<u32>(0x3487351bu, 0x32fb33f8u, 0x314c3218u, 0x2fef3098u); }
        case 58u: { v = vec4<u32>(0x2dea2edcu, 0x2c5c2d17u, 0x2a592b6fu, 0x289e296eu); }
        case 59u: { v = vec4<u32>(0x26c927eeu, 0x24e425c2u, 0x2317242cu, 0x21242214u); }
        case 60u: { v = vec4<u32>(0x3935398du, 0x386738c7u, 0x376d380du, 0x362536c3u); }
        case 61u: { v = vec4<u32>(0x34f93587u, 0x33eb3471u, 0x32353305u, 0x30cd317au); }
        case 62u: { v = vec4<u32>(0x2f693035u, 0x2da22e77u, 0x2c442ce6u, 0x2a662b60u); }
        case 63u: { v = vec4<u32>(0x28cb298au, 0x27262823u, 0x254d262bu, 0x23ca249bu); }
        default: {}
      }
    }
    case 5u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x393b398du, 0x388038d8u, 0x37b7382bu, 0x3682371au); }
        case 1u: { v = vec4<u32>(0x356735f1u, 0x346834e3u, 0x331533e6u, 0x31a8325cu); }
        case 2u: { v = vec4<u32>(0x30773108u, 0x2f082feeu, 0x2d7a2e33u, 0x2c3a2cd1u); }
        case 3u: { v = vec4<u32>(0x2a812b73u, 0x28fe29b8u, 0x279a285bu, 0x25a72691u); }
        case 4u: { v = vec4<u32>(0x3943398du, 0x389738e7u, 0x37fc3849u, 0x36d93769u); }
        case 5u: { v = vec4<u32>(0x35ca364cu, 0x34d4354au, 0x33f43464u, 0x32823330u); }
        case 6u: { v = vec4<u32>(0x314931deu, 0x304030beu, 0x2ec92f96u, 0x2d632e0cu); }
        case 7u: { v = vec4<u32>(0x2c462ccdu, 0x2ab52b8fu, 0x293329e9u, 0x27ef2892u); }
        case 8u: { v = vec4<u32>(0x394a398fu, 0x38aa38f6u, 0x381c3863u, 0x372a37afu); }
        case 9u: { v = vec4<u32>(0x362736a6u, 0x353a35adu, 0x346234ccu, 0x33553402u); }
        case 10u: { v = vec4<u32>(0x321232b0u, 0x31043188u, 0x30193088u, 0x2eaa2f65u); }
        case 11u: { v = vec4<u32>(0x2d662e03u, 0x2c582cd8u, 0x2aef2bc1u, 0x29682a29u); }
        case 12u: { v = vec4<u32>(0x39513992u, 0x38bd3903u, 0x383a387au, 0x377437f3u); }
        case 13u: { v = vec4<u32>(0x368136f8u, 0x359c360cu, 0x34cb3531u, 0x3412346au); }
        case 14u: { v = vec4<u32>(0x32df337eu, 0x31ca3252u, 0x30d33147u, 0x30013066u); }
        case 15u: { v = vec4<u32>(0x2ea22f4cu, 0x2d752e0bu, 0x2c762cedu, 0x2b272c04u); }
        case 16u: { v = vec4<u32>(0x39593995u, 0x38d03911u, 0x38553892u, 0x37bb3819u); }
        case 17u: { v = vec4<u32>(0x36d53748u, 0x35f83666u, 0x352e3591u, 0x347734cfu); }
        case 18u: { v = vec4<u32>(0x33af3425u, 0x3295331eu, 0x31943210u, 0x30b93123u); }
        case 19u: { v = vec4<u32>(0x2ffb3056u, 0x2eb12f51u, 0x2d962e1cu, 0x2c982d18u); }
        case 20u: { v = vec4<u32>(0x39633999u, 0x38e3391eu, 0x387038a8u, 0x38003838u); }
        case 21u: { v = vec4<u32>(0x37243792u, 0x365136bbu, 0x358f35efu, 0x34dd3533u); }
        case 22u: { v = vec4<u32>(0x343d3489u, 0x335e33e6u, 0x325932d8u, 0x317b31e6u); }
        case 23u: { v = vec4<u32>(0x30b73112u, 0x3008305bu, 0x2ed42f6au, 0x2dc32e49u); }
        case 24u: { v = vec4<u32>(0x396d399fu, 0x38f5392du, 0x388938bfu, 0x38213855u); }
        case 25u: { v = vec4<u32>(0x377237d7u, 0x36a8370du, 0x35ea3649u, 0x353f3592u); }
        case 26u: { v = vec4<u32>(0x349f34ebu, 0x34133457u, 0x332333a0u, 0x323d32aeu); }
        case 27u: { v = vec4<u32>(0x317531d4u, 0x30be3116u, 0x301b3069u, 0x2f0d2f9cu); }
        case 28u: { v = vec4<u32>(0x397739a6u, 0x3907393bu, 0x38a438d5u, 0x383f3871u); }
        case 29u: { v = vec4<u32>(0x37bb380eu, 0x36fc3758u, 0x3645369cu, 0x359c35eeu); }
        case 30u: { v = vec4<u32>(0x3501354eu, 0x347634bau, 0x33ef3434u, 0x33073377u); }
        case 31u: { v = vec4<u32>(0x323b329du, 0x317e31d9u, 0x30d53128u, 0x303a3088u); }
        case 32u: { v = vec4<u32>(0x398239aeu, 0x3919394bu, 0x38bb38eau, 0x385d388cu); }
        case 33u: { v = vec4<u32>(0x3800382du, 0x374837a3u, 0x369836f0u, 0x35f63647u); }
        case 34u: { v = vec4<u32>(0x356235abu, 0x34d8351cu, 0x345a3498u, 0x33d13421u); }
        case 35u: { v = vec4<u32>(0x33003368u, 0x324732a1u, 0x319b31eeu, 0x30fd314cu); }
        case 36u: { v = vec4<u32>(0x398f39b8u, 0x392b395bu, 0x38d338feu, 0x387938a7u); }
        case 37u: { v = vec4<u32>(0x381f384cu, 0x379337e8u, 0x36ec373fu, 0x364e369bu); }
        case 38u: { v = vec4<u32>(0x35bd3605u, 0x3539357bu, 0x34bd34f9u, 0x344d3484u); }
        case 39u: { v = vec4<u32>(0x33cd3419u, 0x330f336bu, 0x326832b9u, 0x31ca3216u); }
        case 40u: { v = vec4<u32>(0x399b39c2u, 0x393d396au, 0x38e93913u, 0x389438c0u); }
        case 41u: { v = vec4<u32>(0x3840386au, 0x37d73815u, 0x37393786u, 0x36a236ecu); }
        case 42u: { v = vec4<u32>(0x3616365au, 0x359735d5u, 0x3520355au, 0x34b334e9u); }
        case 43u: { v = vec4<u32>(0x344e3480u, 0x33e3341fu, 0x333a338eu, 0x329f32ecu); }
        case 44u: { v = vec4<u32>(0x39aa39ceu, 0x3950397au, 0x39003927u, 0x38af38d8u); }
        case 45u: { v = vec4<u32>(0x385e3887u, 0x380e3835u, 0x378437cfu, 0x36f3373bu); }
        case 46u: { v = vec4<u32>(0x366d36afu, 0x35f2362fu, 0x357f35b8u, 0x35163548u); }
        case 47u: { v = vec4<u32>(0x34b734e6u, 0x345d3488u, 0x34083432u, 0x337a33c4u); }
        case 48u: { v = vec4<u32>(0x39b739d9u, 0x3963398cu, 0x3915393cu, 0x38c838efu); }
        case 49u: { v = vec4<u32>(0x387b38a1u, 0x382e3855u, 0x37cd3809u, 0x37423787u); }
        case 50u: { v = vec4<u32>(0x36c136ffu, 0x364a3683u, 0x35dc3612u, 0x357635a7u); }
        case 51u: { v = vec4<u32>(0x351b3548u, 0x34c634efu, 0x3475349cu, 0x342b344fu); }
        case 52u: { v = vec4<u32>(0x39c639e6u, 0x3975399cu, 0x392a394fu, 0x38e23906u); }
        case 53u: { v = vec4<u32>(0x389638bcu, 0x384e3871u, 0x3808382au, 0x378b37ccu); }
        case 54u: { v = vec4<u32>(0x3712374du, 0x369f36d6u, 0x36393669u, 0x35d73606u); }
        case 55u: { v = vec4<u32>(0x357f35abu, 0x352d3555u, 0x34e23507u, 0x349b34beu); }
        case 56u: { v = vec4<u32>(0x39d339f2u, 0x398739acu, 0x393f3964u, 0x38f8391bu); }
        case 57u: { v = vec4<u32>(0x38b238d4u, 0x386b388fu, 0x38283849u, 0x37d23808u); }
        case 58u: { v = vec4<u32>(0x375e3797u, 0x36f23727u, 0x369036bfu, 0x36333660u); }
        case 59u: { v = vec4<u32>(0x35e4360au, 0x359635bcu, 0x354e356fu, 0x350b352bu); }
        case 60u: { v = vec4<u32>(0x39e239ffu, 0x399939bcu, 0x39543977u, 0x390f3932u); }
        case 61u: { v = vec4<u32>(0x38ca38ecu, 0x388738a8u, 0x38473867u, 0x380b3828u); }
        case 62u: { v = vec4<u32>(0x37a937dfu, 0x37443776u, 0x36e33713u, 0x368f36b9u); }
        case 63u: { v = vec4<u32>(0x36403666u, 0x35fa361bu, 0x35b535d8u, 0x35783595u); }
        default: {}
      }
    }
    default: {}
  }
  if (lane == 0u) { return v.x; }
  if (lane == 1u) { return v.y; }
  if (lane == 2u) { return v.z; }
  return v.w;
}

struct ClosureSheenSetup {
  lobe: Lobe,
  layer_albedo: vec3<f32>,
  valid: bool,
}

fn closure_empty_lobe() -> Lobe {
  var lobe: Lobe;
  lobe.weight = vec3<f32>(0.0);
  lobe.sample_weight = 0.0;
  lobe.normal = vec3<f32>(0.0, 0.0, 1.0);
  lobe.lobe_type = LOBE_NONE;
  lobe.tangent = vec3<f32>(0.0);
  lobe.flags = 0u;
  lobe.f0 = vec3<f32>(0.0);
  lobe.ior = 1.0;
  lobe.f82_or_tint = vec3<f32>(0.0);
  lobe.diffuse_roughness = 0.0;
  lobe.alpha_x = 0.0;
  lobe.alpha_y = 0.0;
  lobe.thin_film_thickness = 0.0;
  lobe.thin_film_ior = 0.0;
  return lobe;
}

fn closure_layering_weight(layer_albedo: vec3<f32>, current_weight: vec3<f32>) -> vec3<f32> {
  return clamp(current_weight - layer_albedo, vec3<f32>(0.0), current_weight);
}

fn closure_srgb_channel_to_linear(c: f32) -> f32 {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn closure_srgb_to_linear(rgb: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    closure_srgb_channel_to_linear(rgb.x),
    closure_srgb_channel_to_linear(rgb.y),
    closure_srgb_channel_to_linear(rgb.z),
  );
}

fn closure_wrap_coord(coord: f32, wrap_mode: u32) -> f32 {
  if (wrap_mode == 1u) {
    return clamp(coord, 0.0, 1.0);
  }
  if (wrap_mode == 2u) {
    let period = coord - 2.0 * floor(0.5 * coord);
    return select(period, 2.0 - period, period > 1.0);
  }
  return coord - floor(coord);
}

fn closure_wrap_texel_index(idx: i32, dim: i32, wrap_mode: u32) -> i32 {
  if (wrap_mode == 0u) {
    let rem = idx % dim;
    return select(rem, rem + dim, rem < 0);
  }
  return clamp(idx, 0, dim - 1);
}

fn closure_fetch_texel(desc: TextureDescriptor, ix: i32, iy: i32, format: u32) -> vec4<f32> {
  let texel_idx = u32(iy) * desc.width + u32(ix);
  if (format == 2u) {
    let base = desc.data_offset + texel_idx * 4u;
    return vec4<f32>(
      bitcast<f32>(texture_texels[base + 0u]),
      bitcast<f32>(texture_texels[base + 1u]),
      bitcast<f32>(texture_texels[base + 2u]),
      bitcast<f32>(texture_texels[base + 3u]),
    );
  }
  if (format == 3u) {
    let rg = unpack2x16float(texture_texels[desc.data_offset + texel_idx]);
    return vec4<f32>(rg.x, rg.y, 0.0, 1.0);
  }
  let rgba = unpack4x8unorm(texture_texels[desc.data_offset + texel_idx]);
  if (format == 1u) {
    return vec4<f32>(closure_srgb_to_linear(rgba.rgb), rgba.a);
  }
  return rgba;
}

fn closure_sample_texture_uv(tex_index: i32, raw_uv0: vec2<f32>, raw_uv1: vec2<f32>) -> vec4<f32> {
  if (tex_index < 0) {
    return vec4<f32>(1.0);
  }
  let u_idx = u32(tex_index);
  if (u_idx >= kernel_params.texture_count) {
    return vec4<f32>(1.0);
  }
  let desc = texture_descriptors[u_idx];
  if (desc.width == 0u || desc.height == 0u) {
    return vec4<f32>(1.0);
  }
  let flags = desc.format_and_sampler;
  let format = flags & 0xFFu;
  let wrap_u = (flags >> 16u) & 3u;
  let wrap_v = (flags >> 18u) & 3u;
  let is_nearest = ((flags >> 20u) & 1u) != 0u;
  let use_uv1 = ((flags >> 21u) & 1u) != 0u;

  let base_uv = select(raw_uv0, raw_uv1, use_uv1);
  let uv = base_uv * desc.uv_scale + desc.uv_offset;
  let u_wrapped = closure_wrap_coord(uv.x, wrap_u);
  let v_wrapped = closure_wrap_coord(uv.y, wrap_v);
  let w_i = i32(desc.width);
  let h_i = i32(desc.height);

  if (is_nearest) {
    let ix = clamp(i32(floor(u_wrapped * f32(w_i))), 0, w_i - 1);
    let iy = clamp(i32(floor(v_wrapped * f32(h_i))), 0, h_i - 1);
    return closure_fetch_texel(desc, ix, iy, format);
  }

  let fx = u_wrapped * f32(w_i) - 0.5;
  let fy = v_wrapped * f32(h_i) - 0.5;
  let bx0 = i32(floor(fx));
  let by0 = i32(floor(fy));
  let tx = fx - f32(bx0);
  let ty = fy - f32(by0);
  let ix0 = closure_wrap_texel_index(bx0, w_i, wrap_u);
  let ix1 = closure_wrap_texel_index(bx0 + 1, w_i, wrap_u);
  let iy0 = closure_wrap_texel_index(by0, h_i, wrap_v);
  let iy1 = closure_wrap_texel_index(by0 + 1, h_i, wrap_v);

  let c00 = closure_fetch_texel(desc, ix0, iy0, format);
  let c10 = closure_fetch_texel(desc, ix1, iy0, format);
  let c01 = closure_fetch_texel(desc, ix0, iy1, format);
  let c11 = closure_fetch_texel(desc, ix1, iy1, format);
  return mix(mix(c00, c10, tx), mix(c01, c11, tx), ty);
}

fn closure_sample_texture(tex_index: i32, point: ShadingPoint) -> vec4<f32> {
  return closure_sample_texture_uv(tex_index, point.uv0, point.uv1);
}

fn closure_apply_normal_map(
  tex_index: i32,
  strength: f32,
  point: ShadingPoint,
  base_normal: vec3<f32>,
  tangent: vec3<f32>,
  bitangent: vec3<f32>,
) -> vec3<f32> {
  if (tex_index < 0 || u32(tex_index) >= kernel_params.texture_count || strength <= 0.0) {
    return base_normal;
  }
  let desc = texture_descriptors[u32(tex_index)];
  let format = desc.format_and_sampler & 0xFFu;
  let texel = closure_sample_texture(tex_index, point).rgb;
  let nx = (texel.x * 2.0 - 1.0) * strength;
  let ny = (texel.y * 2.0 - 1.0) * strength;
  var nz = texel.z * 2.0 - 1.0;
  if (format == 3u) {
    nz = sqrt(max(0.0, 1.0 - (texel.x * 2.0 - 1.0) * (texel.x * 2.0 - 1.0) - (texel.y * 2.0 - 1.0) * (texel.y * 2.0 - 1.0)));
  }
  let mapped = tangent * nx + bitangent * ny + base_normal * nz;
  return bsdf_mf_safe_normalize_fallback(mapped, base_normal);
}

fn closure_apply_bump_map(
  tex_index: i32,
  bump_distance: f32,
  point: ShadingPoint,
  base_normal: vec3<f32>,
  tangent: vec3<f32>,
  bitangent: vec3<f32>,
) -> vec3<f32> {
  if (tex_index < 0 || u32(tex_index) >= kernel_params.texture_count || bump_distance == 0.0) {
    return base_normal;
  }
  let desc = texture_descriptors[u32(tex_index)];
  if (desc.width == 0u || desc.height == 0u) {
    return base_normal;
  }
  let du = vec2<f32>(1.0 / f32(desc.width), 0.0);
  let dv = vec2<f32>(0.0, 1.0 / f32(desc.height));
  let h_c = bsdf_mf_average(closure_sample_texture_uv(tex_index, point.uv0, point.uv1).rgb);
  let h_u = bsdf_mf_average(closure_sample_texture_uv(tex_index, point.uv0 + du, point.uv1 + du).rgb);
  let h_v = bsdf_mf_average(closure_sample_texture_uv(tex_index, point.uv0 + dv, point.uv1 + dv).rgb);
  let dh_du = (h_u - h_c) * f32(desc.width) * bump_distance;
  let dh_dv = (h_v - h_c) * f32(desc.height) * bump_distance;
  let perturbed = base_normal - dh_du * tangent - dh_dv * bitangent;
  return bsdf_mf_safe_normalize_fallback(perturbed, base_normal);
}

fn closure_read_sheen_ltc(x: f32, y: f32) -> vec3<f32> {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sy = clamp(y, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let y0 = min(u32(sy), 31u);
  let y1 = min(y0 + 1u, 31u);
  let tx = sx - f32(x0);
  let ty = sy - f32(y0);
  let limit = 12u + bsdf_mf_zero_guard();
  var res = vec3<f32>(0.0);
  for (var q: u32 = 0u; q < limit; q = q + 1u) {
    let plane = q >> 2u;
    let corner = q & 3u;
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cy = select(y0, y1, (corner & 2u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wy = select(1.0 - ty, ty, (corner & 2u) != 0u);
    let elem_idx = plane * 1024u + cy * 32u + cx;
    let pair = unpack2x16float(closure_lut_sheen_u32(elem_idx >> 1u));
    let val = select(pair.x, pair.y, (elem_idx & 1u) != 0u) * (wx * wy);
    if (plane == 0u) {
      res.x = res.x + val;
    } else if (plane == 1u) {
      res.y = res.y + val;
    } else {
      res.z = res.z + val;
    }
  }
  return res;
}

fn closure_sheen_make_safe_tangent(normal: vec3<f32>, dir: vec3<f32>) -> mat2x3<f32> {
  let raw_b = cross(normal, dir);
  let len_b = length(raw_b);
  if (len_b < 1e-4) {
    return bsdf_mf_make_orthonormals(normal);
  }
  let bitangent = raw_b / len_b;
  if (dot(bitangent, bitangent) < 0.99) {
    return bsdf_mf_make_orthonormals(normal);
  }
  let tangent = cross(bitangent, normal);
  return mat2x3<f32>(tangent, bitangent);
}

fn closure_sheen_setup_lobe(
  normal: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  roughness: f32,
) -> ClosureSheenSetup {
  let clamped_r = clamp(roughness, 1e-3, 1.0);
  let frame = closure_sheen_make_safe_tangent(normal, wo);
  let cos_no = dot(normal, wo);
  let sheen_ltc = closure_read_sheen_ltc(cos_no, clamped_r);
  let transform_a = sheen_ltc.x;
  let transform_b = sheen_ltc.y;
  let albedo = sheen_ltc.z;

  if (abs(transform_a) < 1e-5 || albedo < 1e-5) {
    return ClosureSheenSetup(closure_empty_lobe(), vec3<f32>(0.0), false);
  }

  var lobe = closure_empty_lobe();
  lobe.weight = weight * albedo;
  lobe.sample_weight = bsdf_mf_average(lobe.weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_SHEEN;
  lobe.tangent = frame[0];
  lobe.f82_or_tint = frame[1];
  lobe.diffuse_roughness = clamped_r;
  lobe.alpha_x = transform_a;
  lobe.alpha_y = transform_b;

  let layer_albedo = vec3<f32>(bsdf_mf_max_component(lobe.weight));
  return ClosureSheenSetup(lobe, layer_albedo, lobe.sample_weight > 0.0);
}

fn closure_sheen_eval(lobe: Lobe, wi: vec3<f32>) -> BsdfMfEval {
  let local_wi = vec3<f32>(dot(wi, lobe.tangent), dot(wi, lobe.f82_or_tint), dot(wi, lobe.normal));
  if (local_wi.z <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let a = lobe.alpha_x;
  let b = lobe.alpha_y;
  let len_sqr = bsdf_mf_sqr(a * local_wi.x + b * local_wi.z) + bsdf_mf_sqr(a * local_wi.y) + bsdf_mf_sqr(local_wi.z);
  if (len_sqr <= 1e-20) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let val = INV_PI * local_wi.z * bsdf_mf_sqr(a / len_sqr);
  return BsdfMfEval(lobe.weight * val, val);
}

fn closure_sheen_sample(
  lobe: Lobe,
  geometric_normal: vec3<f32>,
  rand: vec2<f32>,
) -> BsdfMfSample {
  let a = lobe.alpha_x;
  let b = lobe.alpha_y;
  let disk = bsdf_diffuse_sample_uniform_disk(rand);
  let disk_z = sqrt(max(0.0, 1.0 - dot(disk, disk)));
  let unnorm = vec3<f32>(disk.x - disk_z * b, disk.y, disk_z * a);
  let len_sq = dot(unnorm, unnorm);
  if (len_sq <= 1e-20) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let local_wi = unnorm * inverseSqrt(len_sq);
  if (local_wi.z <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let wi = local_wi.x * lobe.tangent + local_wi.y * lobe.f82_or_tint + local_wi.z * lobe.normal;
  if (dot(geometric_normal, wi) <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let denom = bsdf_mf_sqr(a * local_wi.x + b * local_wi.z) + bsdf_mf_sqr(a * local_wi.y) + bsdf_mf_sqr(local_wi.z);
  let val = INV_PI * local_wi.z * bsdf_mf_sqr(a / max(denom, 1e-20));
  return BsdfMfSample(wi, val, lobe.weight * val, false);
}

fn closure_transparent_setup_lobe(normal: vec3<f32>, weight: vec3<f32>) -> Lobe {
  var lobe = closure_empty_lobe();
  lobe.weight = weight;
  lobe.sample_weight = bsdf_mf_average(weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_TRANSPARENT;
  return lobe;
}

fn closure_thin_glass_transmission_alpha(alpha: f32, eta: f32) -> f32 {
  let safe_eta = max(eta, 1e-4);
  return clamp(alpha * 3.4 * abs(safe_eta - 1.0) * bsdf_mf_sqr(safe_eta - 0.5) / (safe_eta * safe_eta * safe_eta), 0.0, 1.0);
}

fn closure_thin_glass_fresnel(
  reflection_tint: vec3<f32>,
  transmission_tint: vec3<f32>,
  ior: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  cos_theta_i: f32,
) -> BsdfGlassFresnel {
  let f0 = clamp(bsdf_mf_f0_from_ior(ior) * max(reflection_tint, vec3<f32>(0.0)), vec3<f32>(0.0), vec3<f32>(1.0));
  let front4 = bsdf_mf_generalized_schlick_eval(f0, ior, thin_film_thickness, thin_film_ior, cos_theta_i);
  let front_refl = clamp(front4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
  let front_trans = vec3<f32>(1.0) - front_refl;
  let cos_t = front4.w;
  var slab_color = vec3<f32>(0.0);
  if (cos_t < -1e-6) {
    let inv_cos = -1.0 / cos_t;
    let tc = clamp(transmission_tint, vec3<f32>(0.0), vec3<f32>(1.0));
    slab_color = vec3<f32>(
      select(0.0, pow(tc.x, inv_cos), tc.x > 0.0),
      select(0.0, pow(tc.y, inv_cos), tc.y > 0.0),
      select(0.0, pow(tc.z, inv_cos), tc.z > 0.0),
    );
  }
  var back_refl = front_refl;
  var back_trans = front_trans;
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    let inv_ior = 1.0 / max(ior, 1e-5);
    let back4 = bsdf_mf_generalized_schlick_eval(f0, inv_ior, thin_film_thickness, thin_film_ior * inv_ior, -cos_t);
    back_refl = clamp(back4.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
    back_trans = vec3<f32>(1.0) - back_refl;
  }
  let denom = max(vec3<f32>(1.0) - (back_refl * slab_color) * (back_refl * slab_color), vec3<f32>(1e-6));
  let trans = (slab_color * front_trans * back_trans) / denom;
  let refl = front_refl + trans * back_refl * slab_color;
  return BsdfGlassFresnel(clamp(refl, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(trans, vec3<f32>(0.0), vec3<f32>(1.0)), cos_t);
}

fn closure_build(point: ShadingPoint, wo: vec3<f32>) -> Closure {
  var closure: Closure;
  closure.lobes = array<Lobe, 4>(
    closure_empty_lobe(),
    closure_empty_lobe(),
    closure_empty_lobe(),
    closure_empty_lobe(),
  );
  closure.emission = vec3<f32>(0.0);
  closure.lobe_count = 0u;
  closure.absorption_sigma = vec3<f32>(0.0);
  closure.total_sample_weight = 0.0;
  closure.geometric_normal = point.geometric_normal;
  closure.front_face = point.front_face;

  let wo_len_sq = dot(wo, wo);
  if (wo_len_sq <= 1e-16) {
    return closure;
  }
  let wo_dir = wo * inverseSqrt(wo_len_sq);
  let mat = materials[point.material_index];

  var vertex_color = point.vertex_color;
  if (point.triangle_index < kernel_params.triangle_count) {
    if ((triangles[point.triangle_index].flags & TRIANGLE_FLAG_HAS_VERTEX_COLORS) == 0u) {
      vertex_color = vec3<f32>(1.0);
    }
  }

  let smooth_normal = bsdf_mf_safe_normalize_fallback(point.shading_normal, point.geometric_normal);
  var frame_t = point.tangent;
  var frame_b = point.bitangent;
  if (dot(frame_t, frame_t) < 1e-6 || dot(frame_b, frame_b) < 1e-6) {
    let fallback_frame = bsdf_mf_make_orthonormals(smooth_normal);
    frame_t = fallback_frame[0];
    frame_b = fallback_frame[1];
  } else {
    frame_t = normalize(frame_t);
    frame_b = normalize(frame_b);
  }

  var base_color = max(mat.base_color * vertex_color, vec3<f32>(0.0));
  var tex_alpha = 1.0;
  if (mat.base_color_tex >= 0) {
    let bc_tex = closure_sample_texture(mat.base_color_tex, point);
    base_color = max(base_color * bc_tex.rgb, vec3<f32>(0.0));
    tex_alpha = bc_tex.a;
  }
  if (mat.alpha_tex >= 0) {
    tex_alpha = tex_alpha * closure_sample_texture(mat.alpha_tex, point).r;
  }

  var opacity = 1.0;
  let raw_alpha = clamp(mat.alpha * tex_alpha, 0.0, 1.0);
  if (mat.alpha_mode == ALPHA_MODE_MASK) {
    if (raw_alpha < mat.alpha_cutoff) {
      let trans_lobe = closure_transparent_setup_lobe(smooth_normal, vec3<f32>(1.0));
      closure.lobes[0] = trans_lobe;
      closure.lobe_count = 1u;
      closure.total_sample_weight = trans_lobe.sample_weight;
      return closure;
    }
  } else if (mat.alpha_mode == ALPHA_MODE_BLEND) {
    opacity = raw_alpha;
    if (opacity <= 0.0) {
      let trans_lobe = closure_transparent_setup_lobe(smooth_normal, vec3<f32>(1.0));
      closure.lobes[0] = trans_lobe;
      closure.lobe_count = 1u;
      closure.total_sample_weight = trans_lobe.sample_weight;
      return closure;
    }
  }

  var roughness = clamp(mat.roughness, 0.0, 1.0);
  var metallic = clamp(mat.metallic, 0.0, 1.0);
  if (mat.metallic_roughness_tex >= 0) {
    let mr_tex = closure_sample_texture(mat.metallic_roughness_tex, point);
    roughness = clamp(roughness * mr_tex.g, 0.0, 1.0);
    metallic = clamp(metallic * mr_tex.b, 0.0, 1.0);
  }

  var transmission_weight = clamp(mat.transmission_weight, 0.0, 1.0);
  if (mat.transmission_tex >= 0) {
    transmission_weight = clamp(transmission_weight * closure_sample_texture(mat.transmission_tex, point).r, 0.0, 1.0);
  }

  var coat_weight = max(mat.coat_weight, 0.0);
  var coat_roughness = clamp(mat.coat_roughness, 0.0, 1.0);
  if (mat.coat_weight_roughness_tex >= 0) {
    let cwr_tex = closure_sample_texture(mat.coat_weight_roughness_tex, point);
    coat_weight = max(coat_weight * cwr_tex.r, 0.0);
    coat_roughness = clamp(coat_roughness * cwr_tex.g, 0.0, 1.0);
  }
  var coat_tint = max(mat.coat_tint, vec3<f32>(0.0));
  if (mat.coat_tint_tex >= 0) {
    coat_tint = max(coat_tint * closure_sample_texture(mat.coat_tint_tex, point).rgb, vec3<f32>(0.0));
  }

  var sheen_weight = max(mat.sheen_weight, 0.0);
  var sheen_tint = max(mat.sheen_tint, vec3<f32>(0.0));
  var sheen_roughness = clamp(mat.sheen_roughness, 0.0, 1.0);
  if (mat.sheen_color_roughness_tex >= 0) {
    let scr_tex = closure_sample_texture(mat.sheen_color_roughness_tex, point);
    sheen_tint = max(sheen_tint * scr_tex.rgb, vec3<f32>(0.0));
    sheen_roughness = clamp(sheen_roughness * scr_tex.a, 0.0, 1.0);
  }

  var anisotropic = clamp(mat.anisotropy, 0.0, 1.0);
  var aniso_rotation = mat.anisotropy_rotation;
  if (mat.anisotropy_tex >= 0) {
    let ani_tex = closure_sample_texture(mat.anisotropy_tex, point);
    anisotropic = clamp(anisotropic * ani_tex.b, 0.0, 1.0);
    let dir_xy = ani_tex.rg * 2.0 - vec2<f32>(1.0);
    if (dot(dir_xy, dir_xy) > 1e-6) {
      aniso_rotation = aniso_rotation + atan2(dir_xy.y, dir_xy.x) * INV_TWO_PI;
    }
  }

  var emission_color = max(mat.emission_color, vec3<f32>(0.0));
  if (mat.emission_tex >= 0) {
    emission_color = max(emission_color * closure_sample_texture(mat.emission_tex, point).rgb, vec3<f32>(0.0));
  }

  var shading_n = closure_apply_normal_map(mat.normal_tex, mat.normal_scale, point, smooth_normal, frame_t, frame_b);
  shading_n = closure_apply_bump_map(mat.bump_tex, mat.bump_distance, point, shading_n, frame_t, frame_b);

  var raw_coat_n = bsdf_mf_safe_normalize_fallback(point.coat_normal, shading_n);
  raw_coat_n = closure_apply_normal_map(mat.coat_normal_tex, mat.coat_normal_scale, point, raw_coat_n, frame_t, frame_b);

  let preserve_energy = (mat.flags & MATERIAL_FLAG_MULTISCATTER_GGX) != 0u;
  let thin_walled = (mat.flags & MATERIAL_FLAG_THIN_WALLED) != 0u;

  var candidates: array<Lobe, 7>;
  var cand_count: u32 = 0u;
  var layer_weight = vec3<f32>(1.0);

  if (opacity < 1.0) {
    let trans_lobe = closure_transparent_setup_lobe(shading_n, vec3<f32>(1.0 - opacity));
    if (trans_lobe.sample_weight > 0.0) {
      candidates[cand_count] = trans_lobe;
      cand_count = cand_count + 1u;
    }
    layer_weight = vec3<f32>(opacity);
  }

  if (sheen_weight > CLOSURE_WEIGHT_CUTOFF) {
    let sheen_n = bsdf_mf_safe_normalize_fallback(mix(shading_n, raw_coat_n, clamp(coat_weight, 0.0, 1.0)), shading_n);
    let sheen_w = sheen_weight * sheen_tint * layer_weight;
    let sheen_setup = closure_sheen_setup_lobe(sheen_n, wo_dir, sheen_w, sheen_roughness);
    if (sheen_setup.valid) {
      candidates[cand_count] = sheen_setup.lobe;
      cand_count = cand_count + 1u;
      layer_weight = closure_layering_weight(sheen_setup.layer_albedo, layer_weight);
    }
  }

  if (coat_weight > CLOSURE_WEIGHT_CUTOFF) {
    let coat_w = coat_weight * layer_weight;
    let coat_setup = bsdf_coat_setup_lobe(
      point.geometric_normal,
      raw_coat_n,
      wo_dir,
      coat_w,
      coat_roughness,
      mat.coat_ior,
      coat_tint,
      preserve_energy,
    );
    if (coat_setup.lobe.sample_weight > 0.0) {
      candidates[cand_count] = coat_setup.lobe;
      cand_count = cand_count + 1u;
    }
    layer_weight = closure_layering_weight(coat_setup.layer_albedo, layer_weight);
  }

  let emission = emission_color * max(mat.emission_strength, 0.0);
  if (any(emission > vec3<f32>(0.0))) {
    closure.emission = emission * layer_weight;
  }

  let clamped_base_color = clamp(base_color, vec3<f32>(0.0), vec3<f32>(1.0));
  let ior = max(mat.ior, 1e-5);
  let valid_refl_n = bsdf_mf_ensure_valid_specular_reflection(point.geometric_normal, wo_dir, shading_n);
  var specular_tint = max(mat.f82_tint, vec3<f32>(0.0));
  if ((mat.flags & MATERIAL_FLAG_F82_METALLIC) == 0u && all(specular_tint == vec3<f32>(0.0))) {
    specular_tint = vec3<f32>(1.0);
  }
  let thin_film_thickness = mat.thin_film_thickness;
  let thin_film_ior = select(0.0, max(mat.thin_film_ior, 1e-5), thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);

  var alpha_x = roughness * roughness;
  var alpha_y = roughness * roughness;
  var aniso_t = vec3<f32>(0.0);
  if (anisotropic > 0.0) {
    aniso_t = frame_t;
    let aspect = sqrt(1.0 - anisotropic * 0.9);
    alpha_x = alpha_x / aspect;
    alpha_y = alpha_y * aspect;
    if (aniso_rotation != 0.0) {
      aniso_t = bsdf_mf_rotate_around_axis(aniso_t, shading_n, aniso_rotation * TWO_PI);
    }
  }

  if (metallic > CLOSURE_WEIGHT_CUTOFF) {
    let metal_w = metallic * layer_weight;
    let f82 = min(specular_tint, vec3<f32>(1.0));
    let metal_lobe = bsdf_mf_setup_conductor_lobe(
      valid_refl_n,
      aniso_t,
      wo_dir,
      metal_w,
      clamped_base_color,
      f82,
      alpha_x,
      alpha_y,
      thin_film_thickness,
      thin_film_ior,
      preserve_energy,
    );
    if (metal_lobe.sample_weight > 0.0) {
      candidates[cand_count] = metal_lobe;
      cand_count = cand_count + 1u;
    }
    layer_weight = layer_weight * (1.0 - metallic);
  }

  if (transmission_weight > CLOSURE_WEIGHT_CUTOFF && bsdf_mf_max_component(layer_weight) > CLOSURE_WEIGHT_CUTOFF) {
    let trans_w = transmission_weight * layer_weight;
    if (thin_walled) {
      let cos_no = max(dot(valid_refl_n, wo_dir), 0.0);
      let tf = closure_thin_glass_fresnel(specular_tint, clamped_base_color, ior, thin_film_thickness, thin_film_ior, cos_no);
      let base_alpha = roughness * roughness;
      var refl_lobe = closure_empty_lobe();
      refl_lobe.weight = tf.reflectance * trans_w;
      refl_lobe.sample_weight = bsdf_mf_average(refl_lobe.weight);
      refl_lobe.normal = valid_refl_n;
      refl_lobe.lobe_type = LOBE_GLOSSY_GGX;
      refl_lobe.flags = LOBE_FLAG_F82_TINT;
      refl_lobe.f0 = vec3<f32>(1.0);
      refl_lobe.diffuse_roughness = 1.0;
      refl_lobe.alpha_x = base_alpha;
      refl_lobe.alpha_y = base_alpha;
      if (preserve_energy) {
        let pres = bsdf_mf_preserve_energy_glossy(valid_refl_n, vec3<f32>(0.0), wo_dir, base_alpha, base_alpha, clamp(specular_tint, vec3<f32>(0.0), vec3<f32>(1.0)));
        refl_lobe.weight = refl_lobe.weight * pres.xyz;
        refl_lobe.sample_weight = bsdf_mf_average(refl_lobe.weight);
        refl_lobe.diffuse_roughness = pres.w;
      }
      if (refl_lobe.sample_weight > 0.0) {
        candidates[cand_count] = refl_lobe;
        cand_count = cand_count + 1u;
      }

      let trans_alpha = closure_thin_glass_transmission_alpha(base_alpha, ior);
      var thin_trans_lobe = closure_empty_lobe();
      thin_trans_lobe.weight = tf.transmittance * trans_w;
      thin_trans_lobe.sample_weight = bsdf_mf_average(thin_trans_lobe.weight);
      thin_trans_lobe.normal = -valid_refl_n;
      thin_trans_lobe.lobe_type = LOBE_GLOSSY_GGX;
      thin_trans_lobe.flags = LOBE_FLAG_THIN_WALLED | LOBE_FLAG_F82_TINT;
      thin_trans_lobe.f0 = vec3<f32>(1.0);
      thin_trans_lobe.diffuse_roughness = 1.0;
      thin_trans_lobe.alpha_x = trans_alpha;
      thin_trans_lobe.alpha_y = trans_alpha;
      if (preserve_energy) {
        let wo_mirrored = wo_dir - 2.0 * dot(wo_dir, valid_refl_n) * valid_refl_n;
        let pres_t = bsdf_mf_preserve_energy_glossy(-valid_refl_n, vec3<f32>(0.0), wo_mirrored, trans_alpha, trans_alpha, vec3<f32>(1.0));
        thin_trans_lobe.diffuse_roughness = pres_t.w;
      }
      if (thin_trans_lobe.sample_weight > 0.0) {
        candidates[cand_count] = thin_trans_lobe;
        cand_count = cand_count + 1u;
      }
    } else {
      let glass_lobe = bsdf_glass_setup_lobe(
        valid_refl_n,
        aniso_t,
        wo_dir,
        trans_w,
        ior,
        point.front_face,
        specular_tint,
        sqrt(clamped_base_color),
        alpha_x,
        alpha_y,
        thin_film_thickness,
        thin_film_ior,
        preserve_energy,
      );
      if (glass_lobe.sample_weight > 0.0) {
        candidates[cand_count] = glass_lobe;
        cand_count = cand_count + 1u;
      }
      if (mat.absorption_distance > 0.0) {
        let clamped_abs = clamp(mat.absorption_color, vec3<f32>(1e-6), vec3<f32>(1.0));
        closure.absorption_sigma = max(-log(clamped_abs) / mat.absorption_distance, vec3<f32>(0.0));
      }
    }
    layer_weight = layer_weight * (1.0 - transmission_weight);
  }

  let specular_ior_level = max(mat.specular_ior_level, 0.0);
  var eta_spec = ior;
  var f0_scalar = bsdf_mf_f0_from_ior(eta_spec);
  if (specular_ior_level != 0.5) {
    f0_scalar = f0_scalar * 2.0 * specular_ior_level;
    eta_spec = bsdf_mf_ior_from_f0(f0_scalar);
    if (ior < 1.0) {
      eta_spec = 1.0 / eta_spec;
    }
  }

  if (bsdf_mf_max_component(layer_weight) > CLOSURE_WEIGHT_CUTOFF && (eta_spec != 1.0 || thin_film_thickness > BSDF_MF_THINFILM_CUTOFF)) {
    let spec_setup = bsdf_mf_setup_dielectric_specular_lobe(
      valid_refl_n,
      aniso_t,
      wo_dir,
      layer_weight,
      f0_scalar * specular_tint,
      eta_spec,
      alpha_x,
      alpha_y,
      thin_film_thickness,
      thin_film_ior,
      preserve_energy,
    );
    if (spec_setup.lobe.sample_weight > 0.0) {
      candidates[cand_count] = spec_setup.lobe;
      cand_count = cand_count + 1u;
    }
    layer_weight = closure_layering_weight(spec_setup.layer_albedo, layer_weight);
  }

  let diffuse_weight = base_color * layer_weight;
  if (bsdf_mf_max_component(diffuse_weight) > CLOSURE_WEIGHT_CUTOFF) {
    let diff_lobe = bsdf_diffuse_setup_lobe(
      shading_n,
      wo_dir,
      diffuse_weight,
      clamped_base_color,
      mat.diffuse_roughness,
    );
    if (diff_lobe.sample_weight > 0.0) {
      candidates[cand_count] = diff_lobe;
      cand_count = cand_count + 1u;
    }
  }

  if (cand_count <= MAX_CLOSURE_LOBES) {
    for (var i: u32 = 0u; i < cand_count; i = i + 1u) {
      closure.lobes[i] = candidates[i];
      closure.total_sample_weight = closure.total_sample_weight + candidates[i].sample_weight;
    }
    closure.lobe_count = cand_count;
  } else {
    var used_mask: u32 = 0u;
    var out_idx: u32 = 0u;
    if (candidates[0].lobe_type == LOBE_TRANSPARENT) {
      closure.lobes[0] = candidates[0];
      closure.total_sample_weight = closure.total_sample_weight + candidates[0].sample_weight;
      used_mask = 1u;
      out_idx = 1u;
    }
    for (; out_idx < MAX_CLOSURE_LOBES; out_idx = out_idx + 1u) {
      var best_j: u32 = 0u;
      var best_w: f32 = -1.0;
      for (var j: u32 = 0u; j < cand_count; j = j + 1u) {
        if (((used_mask >> j) & 1u) == 0u && candidates[j].sample_weight > best_w) {
          best_w = candidates[j].sample_weight;
          best_j = j;
        }
      }
      used_mask = used_mask | (1u << best_j);
      closure.lobes[out_idx] = candidates[best_j];
      closure.total_sample_weight = closure.total_sample_weight + candidates[best_j].sample_weight;
    }
    closure.lobe_count = MAX_CLOSURE_LOBES;
  }

  return closure;
}

fn closure_eval_single_lobe(lobe: Lobe, wi: vec3<f32>, wo: vec3<f32>) -> BsdfMfEval {
  if (lobe.lobe_type == LOBE_DIFFUSE) {
    let d = bsdf_diffuse_eval(lobe, wi, wo);
    return BsdfMfEval(d.value, d.pdf);
  }
  if (lobe.lobe_type == LOBE_GLOSSY_GGX) {
    let is_tw = (lobe.flags & LOBE_FLAG_THIN_WALLED) != 0u;
    let eval_wo = select(wo, wo - 2.0 * dot(wo, lobe.normal) * lobe.normal, is_tw);
    return bsdf_mf_eval(lobe, wi, eval_wo);
  }
  if (lobe.lobe_type == LOBE_GLASS_GGX) {
    return bsdf_glass_eval(lobe, wi, wo);
  }
  if (lobe.lobe_type == LOBE_COAT_GGX) {
    return bsdf_coat_eval(lobe, wi, wo);
  }
  if (lobe.lobe_type == LOBE_SHEEN) {
    return closure_sheen_eval(lobe, wi);
  }
  return BsdfMfEval(vec3<f32>(0.0), 0.0);
}

fn closure_eval(closure: Closure, wi: vec3<f32>, wo: vec3<f32>) -> ClosureEval {
  if (closure.lobe_count == 0u || closure.total_sample_weight <= 0.0) {
    return ClosureEval(vec3<f32>(0.0), 0.0);
  }
  var total_value = vec3<f32>(0.0);
  var total_pdf = 0.0;
  let inv_total_w = 1.0 / closure.total_sample_weight;
  for (var i: u32 = 0u; i < closure.lobe_count; i = i + 1u) {
    let lobe = closure.lobes[i];
    if (lobe.sample_weight <= 0.0 || lobe.lobe_type == LOBE_TRANSPARENT) {
      continue;
    }
    let lobe_prob = lobe.sample_weight * inv_total_w;
    let ev = closure_eval_single_lobe(lobe, wi, wo);
    total_value = total_value + ev.value;
    total_pdf = total_pdf + lobe_prob * ev.pdf;
  }
  return ClosureEval(total_value, total_pdf);
}

fn closure_sample_single_lobe(
  lobe: Lobe,
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  rand_xy: vec2<f32>,
  rand_lobe: f32,
) -> BsdfMfSample {
  if (lobe.lobe_type == LOBE_DIFFUSE) {
    let s = bsdf_diffuse_sample(lobe, geometric_normal, wo, rand_xy);
    return BsdfMfSample(s.wi, s.pdf, s.eval, false);
  }
  if (lobe.lobe_type == LOBE_GLOSSY_GGX) {
    let is_tw = (lobe.flags & LOBE_FLAG_THIN_WALLED) != 0u;
    if (is_tw && bsdf_mf_is_singular(lobe.alpha_x, lobe.alpha_y)) {
      return BsdfMfSample(-wo, CLOSURE_SINGULAR_WEIGHT, lobe.weight * CLOSURE_SINGULAR_WEIGHT, true);
    }
    let samp_ng = select(geometric_normal, -geometric_normal, is_tw);
    let samp_wo = select(wo, wo - 2.0 * dot(wo, lobe.normal) * lobe.normal, is_tw);
    return bsdf_mf_sample(lobe, samp_ng, samp_wo, rand_xy);
  }
  if (lobe.lobe_type == LOBE_GLASS_GGX) {
    return bsdf_glass_sample(lobe, geometric_normal, wo, rand_xy, rand_lobe);
  }
  if (lobe.lobe_type == LOBE_COAT_GGX) {
    return bsdf_coat_sample(lobe, geometric_normal, wo, rand_xy);
  }
  if (lobe.lobe_type == LOBE_SHEEN) {
    return closure_sheen_sample(lobe, geometric_normal, rand_xy);
  }
  if (lobe.lobe_type == LOBE_TRANSPARENT) {
    return BsdfMfSample(-wo, CLOSURE_SINGULAR_WEIGHT, lobe.weight * CLOSURE_SINGULAR_WEIGHT, true);
  }
  return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
}

fn closure_sample(closure: Closure, wo: vec3<f32>, u: vec3<f32>) -> ClosureSample {
  if (closure.lobe_count == 0u || closure.total_sample_weight <= 0.0) {
    return ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  }

  let cdf_target = clamp(u.x, 0.0, 0.99999994) * closure.total_sample_weight;
  var chosen_idx: u32 = closure.lobe_count - 1u;
  var cdf_prev = 0.0;
  for (var i: u32 = 0u; i < closure.lobe_count; i = i + 1u) {
    let next_cdf = cdf_prev + closure.lobes[i].sample_weight;
    if (cdf_target < next_cdf || i == closure.lobe_count - 1u) {
      chosen_idx = i;
      break;
    }
    cdf_prev = next_cdf;
  }

  let chosen_lobe = closure.lobes[chosen_idx];
  if (chosen_lobe.sample_weight <= 0.0) {
    return ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  }

  let lobe_prob = chosen_lobe.sample_weight / closure.total_sample_weight;
  let u_lobe = clamp((cdf_target - cdf_prev) / max(chosen_lobe.sample_weight, 1e-20), 0.0, 0.99999994);
  let rand_xy = clamp(u.yz, vec2<f32>(0.0), vec2<f32>(0.99999994));

  let s = closure_sample_single_lobe(chosen_lobe, closure.geometric_normal, wo, rand_xy, u_lobe);
  if (s.pdf <= 0.0) {
    return ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  }
  if (s.is_singular) {
    return ClosureSample(s.wi, lobe_prob * s.pdf, s.eval, chosen_lobe.lobe_type);
  }

  let mix_ev = closure_eval(closure, s.wi, wo);
  if (mix_ev.pdf <= 0.0) {
    return ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  }
  return ClosureSample(s.wi, mix_ev.pdf, mix_ev.value, chosen_lobe.lobe_type);
}

fn closure_eval_albedo(closure: Closure, wo: vec3<f32>) -> vec3<f32> {
  var albedo = vec3<f32>(0.0);
  for (var i: u32 = 0u; i < closure.lobe_count; i = i + 1u) {
    let lobe = closure.lobes[i];
    if (lobe.lobe_type == LOBE_DIFFUSE || lobe.lobe_type == LOBE_SHEEN) {
      albedo = albedo + lobe.weight;
    } else if (lobe.lobe_type == LOBE_GLOSSY_GGX) {
      let fr = bsdf_mf_eval_glossy_fresnel(lobe, max(dot(lobe.normal, wo), 0.0));
      albedo = albedo + lobe.weight * fr;
    } else if (lobe.lobe_type == LOBE_GLASS_GGX) {
      let gr = bsdf_glass_fresnel(lobe, max(dot(lobe.normal, wo), 0.0));
      albedo = albedo + lobe.weight * (gr.reflectance + gr.transmittance);
    } else if (lobe.lobe_type == LOBE_COAT_GGX) {
      let fc = bsdf_mf_fresnel_dielectric_cos(max(dot(lobe.normal, wo), 0.0), lobe.ior);
      albedo = albedo + lobe.weight * fc;
    }
  }
  return clamp(albedo, vec3<f32>(0.0), vec3<f32>(1.0));
}

fn closure_eval_normal(closure: Closure) -> vec3<f32> {
  if (closure.lobe_count == 0u) {
    return closure.geometric_normal;
  }
  var sum_n = vec3<f32>(0.0);
  for (var i: u32 = 0u; i < closure.lobe_count; i = i + 1u) {
    let lobe = closure.lobes[i];
    if (lobe.lobe_type != LOBE_TRANSPARENT) {
      sum_n = sum_n + lobe.normal * lobe.sample_weight;
    }
  }
  return bsdf_mf_safe_normalize_fallback(sum_n, closure.geometric_normal);
}

fn closure_pcg3d(v_in: vec3<u32>) -> vec3<u32> {
  var v = v_in * 1664525u + vec3<u32>(1013904223u);
  v.x = v.x + v.y * v.z;
  v.y = v.y + v.z * v.x;
  v.z = v.z + v.x * v.y;
  v = v ^ (v >> vec3<u32>(16u));
  v.x = v.x + v.y * v.z;
  v.y = v.y + v.z * v.x;
  v.z = v.z + v.x * v.y;
  return v;
}

@compute @workgroup_size(64, 1, 1)
fn test_lobe_samples(@builtin(global_invocation_id) gid: vec3<u32>) {
  let width = kernel_params.image_width;
  let height = kernel_params.image_height;
  let total = width * height;
  let idx = gid.x;
  if (idx >= total) {
    return;
  }

  var point: ShadingPoint;
  point.position = vec3<f32>(0.0, 0.0, 0.0);
  point.ray_t = 1.0;
  point.geometric_normal = vec3<f32>(0.0, 0.0, 1.0);
  point.front_face = select(0u, 1u, kernel_params.camera_near >= 0.0);
  point.shading_normal = vec3<f32>(0.0, 0.0, 1.0);
  point.material_index = 0u;
  point.coat_normal = vec3<f32>(0.0, 0.0, 1.0);
  point.instance_index = 0u;
  point.tangent = vec3<f32>(1.0, 0.0, 0.0);
  point.triangle_index = 0u;
  point.bitangent = vec3<f32>(0.0, 1.0, 0.0);
  point.emissive_index = INVALID_INDEX;
  point.uv0 = vec2<f32>(0.5, 0.5);
  point.uv1 = vec2<f32>(0.5, 0.5);
  point.barycentrics = vec2<f32>(0.25, 0.25);
  point.object_random = 0.0;
  point.light_group_mask_lo = 0xFFFFFFFFu;
  point.vertex_color = vec3<f32>(1.0);
  point.light_group_mask_hi = 0xFFFFFFFFu;

  let wo = bsdf_mf_safe_normalize_fallback(kernel_params.camera_forward, vec3<f32>(0.0, 0.0, 1.0));
  let closure = closure_build(point, wo);
  let mode = kernel_params.kernel_flags;

  var eval_wi = vec3<f32>(0.0);
  var do_eval = false;
  var jacobian = 1.0;
  var samp = ClosureSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), LOBE_NONE);
  var u = vec3<f32>(0.0);

  if (mode == 1u) {
    let ix = idx % width;
    let iy = idx / width;
    let u_grid = (f32(ix) + 0.5) / f32(max(width, 1u));
    let v_grid = (f32(iy) + 0.5) / f32(max(height, 1u));
    let z = 1.0 - 2.0 * v_grid;
    let r = sqrt(max(0.0, 1.0 - z * z));
    let phi = TWO_PI * u_grid;
    eval_wi = vec3<f32>(r * cos(phi), r * sin(phi), z);
    do_eval = true;
  } else if (mode == 3u || mode == 4u) {
    let ix = idx % width;
    let iy = idx / width;
    let u_grid = (f32(ix) + 0.5) / f32(max(width, 1u));
    let v_grid = (f32(iy) + 0.5) / f32(max(height, 1u));
    let r_mat = clamp(materials[0].roughness, 0.0, 1.0);
    var alpha_char = clamp(r_mat * r_mat, 1e-4, 1.0);
    if (materials[0].coat_weight > 0.0) {
      let cr_mat = clamp(materials[0].coat_roughness, 0.0, 1.0);
      alpha_char = min(alpha_char, clamp(cr_mat * cr_mat, 1e-4, 1.0));
    }
    let one_minus_v = max(1.0 - v_grid, 1e-6);
    let v2 = v_grid * v_grid;
    let tan_half = (alpha_char * v_grid + v2 * v_grid) / one_minus_v;
    let s2 = tan_half * tan_half;
    let inv_1ps2 = 1.0 / (1.0 + s2);
    let cos_gamma = (1.0 - s2) * inv_1ps2;
    let sin_gamma = 2.0 * tan_half * inv_1ps2;
    let dtdv = (alpha_char + 3.0 * v2 - 2.0 * v2 * v_grid) / (one_minus_v * one_minus_v);
    let dcos_dv = 4.0 * tan_half * inv_1ps2 * inv_1ps2 * dtdv;
    let phi = TWO_PI * u_grid;
    var axis = normalize(vec3<f32>(-wo.x, -wo.y, wo.z));
    if (mode == 4u) {
      if ((materials[0].flags & MATERIAL_FLAG_THIN_WALLED) != 0u) {
        axis = -wo;
      } else {
        let eta_g = select(1.0 / max(materials[0].ior, 1e-5), max(materials[0].ior, 1e-5), point.front_face != 0u);
        let diel_g = bsdf_mf_fresnel_dielectric(max(wo.z, 0.0), eta_g);
        if (diel_g.y < 0.0) {
          axis = normalize(bsdf_glass_refract_angle(wo, vec3<f32>(0.0, 0.0, 1.0), diel_g.y, 1.0 / eta_g));
        } else {
          axis = vec3<f32>(0.0, 0.0, -1.0);
        }
      }
    }
    let frame = bsdf_mf_make_orthonormals(axis);
    eval_wi = sin_gamma * cos(phi) * frame[0] + sin_gamma * sin(phi) * frame[1] + cos_gamma * axis;
    jacobian = (TWO_PI * dcos_dv) / f32(max(total, 1u));
    do_eval = true;
  } else {
    let rng = closure_pcg3d(vec3<u32>(idx, kernel_params.seed, 0x9E3779B9u));
    u = vec3<f32>(
      f32(rng.x >> 8u) * CLOSURE_PCG_INV_24,
      f32(rng.y >> 8u) * CLOSURE_PCG_INV_24,
      f32(rng.z >> 8u) * CLOSURE_PCG_INV_24,
    );
    samp = closure_sample(closure, wo, u);
    eval_wi = samp.wi;
    do_eval = samp.pdf > 0.0;
  }

  var ev = ClosureEval(vec3<f32>(0.0), 0.0);
  if (do_eval) {
    ev = closure_eval(closure, eval_wi, wo);
  }

  if (mode == 1u) {
    film_accumulation[idx] = vec4<f32>(eval_wi, ev.pdf);
    film_accumulation[total + idx] = vec4<f32>(ev.value, 0.0);
    film_accumulation[2u * total + idx] = vec4<f32>(closure.emission, closure.total_sample_weight);
    film_accumulation[3u * total + idx] = vec4<f32>(closure.absorption_sigma, f32(closure.lobe_count));
    return;
  }
  if (mode == 3u || mode == 4u) {
    film_accumulation[idx] = vec4<f32>(eval_wi, ev.pdf * jacobian);
    film_accumulation[total + idx] = vec4<f32>(ev.value * jacobian, f32(closure.lobe_count));
    film_accumulation[2u * total + idx] = vec4<f32>(ev.value, ev.pdf);
    film_accumulation[3u * total + idx] = vec4<f32>(closure.absorption_sigma, closure.total_sample_weight);
    return;
  }

  film_accumulation[idx] = vec4<f32>(samp.wi, samp.pdf);
  film_accumulation[total + idx] = vec4<f32>(samp.eval, f32(samp.sampled_lobe_type));
  film_accumulation[2u * total + idx] = vec4<f32>(ev.value, ev.pdf);
  film_accumulation[3u * total + idx] = vec4<f32>(u, f32(closure.lobe_count));
}
