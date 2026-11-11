/* SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
 * SPDX-FileCopyrightText: 2011-2026 Blender Foundation
 *
 * SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
 *
 * Adapted code from Open Shading Language and Blender Cycles
 * (kernel/closure/bsdf_microfacet.h, kernel/closure/bsdf_util.h, kernel/util/lookup_table.h). */

const BSDF_MF_SPECULAR_THRESHOLD: f32 = 2e-10;
const BSDF_MF_SINGULAR_WEIGHT: f32 = 1e6;
const BSDF_MF_THINFILM_CUTOFF: f32 = 0.1;
const BSDF_MF_ONE_THIRD: f32 = 0.3333333333333333;
const BSDF_MF_INV_255: f32 = 0.00392156862745098;
const BSDF_MF_INV_65535: f32 = 1.5259021896696422e-5;
const BSDF_MF_THIN_FILM_SIZE: i32 = 512;

fn bsdf_mf_lut_small_u32(word_idx: u32) -> u32 {
  let vec_idx = word_idx >> 2u;
  let lane = word_idx & 3u;
  var v = vec4<u32>(0u);
  switch (vec_idx >> 6u) {
    case 0u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfafbffffu, 0xff6bfeb5u, 0xffc9ffabu, 0xffe2ffd8u); }
        case 1u: { v = vec4<u32>(0xffeaffe7u, 0xffedffecu, 0xffeeffeeu, 0xffecffedu); }
        case 2u: { v = vec4<u32>(0xffe9ffebu, 0xffe6ffe8u, 0xffe1ffe4u, 0xffdcffdfu); }
        case 3u: { v = vec4<u32>(0xffd7ffdau, 0xffd0ffd4u, 0xffcaffcdu, 0xffc3ffc6u); }
        case 4u: { v = vec4<u32>(0xe45effffu, 0xfa39f3dbu, 0xfdd6fcadu, 0xfed6fe77u); }
        case 5u: { v = vec4<u32>(0xff37ff11u, 0xff5dff4eu, 0xff67ff64u, 0xff60ff65u); }
        case 6u: { v = vec4<u32>(0xff4eff58u, 0xff35ff42u, 0xff14ff25u, 0xfeeeff02u); }
        case 7u: { v = vec4<u32>(0xfec3fed9u, 0xfe94feacu, 0xfe61fe7bu, 0xfe2bfe46u); }
        case 8u: { v = vec4<u32>(0xf6ecffffu, 0xeccfe45du, 0xf7ccf3d2u, 0xfb87fa1cu); }
        case 9u: { v = vec4<u32>(0xfd06fc6fu, 0xfdaafd6au, 0xfde2fdd0u, 0xfdddfde6u); }
        case 10u: { v = vec4<u32>(0xfdaffdcau, 0xfd64fd8du, 0xfd01fd35u, 0xfc8bfcc8u); }
        case 11u: { v = vec4<u32>(0xfc05fc4au, 0xfb71fbbdu, 0xfad1fb23u, 0xfa27fa7du); }
        case 12u: { v = vec4<u32>(0xfe23ffffu, 0xe459ec15u, 0xef7be9a1u, 0xf677f3a9u); }
        case 13u: { v = vec4<u32>(0xf9a0f859u, 0xfb0ffa7cu, 0xfb9ffb6bu, 0xfbadfbb3u); }
        case 14u: { v = vec4<u32>(0xfb65fb92u, 0xfadffb29u, 0xfa29fa89u, 0xf94df9bfu); }
        case 15u: { v = vec4<u32>(0xf850f8d2u, 0xf738f7c7u, 0xf609f6a3u, 0xf4c7f56au); }
        case 16u: { v = vec4<u32>(0xff71ffffu, 0xe7eaf6ebu, 0xe7ede44eu, 0xf067ec92u); }
        case 17u: { v = vec4<u32>(0xf549f33fu, 0xf7b5f6b8u, 0xf8bef85bu, 0xf8f2f8edu); }
        case 18u: { v = vec4<u32>(0xf896f8d3u, 0xf7d4f840u, 0xf6c2f754u, 0xf571f621u); }
        case 19u: { v = vec4<u32>(0xf3edf4b5u, 0xf23df31au, 0xf06af158u, 0xee78ef75u); }
        case 20u: { v = vec4<u32>(0xffc7ffffu, 0xf048fc10u, 0xe437e624u, 0xea7ce6d4u); }
        case 21u: { v = vec4<u32>(0xf06aedcau, 0xf3cdf262u, 0xf562f4c5u, 0xf5c9f5b4u); }
        case 22u: { v = vec4<u32>(0xf561f5abu, 0xf463f4f2u, 0xf2f1f3b7u, 0xf124f215u); }
        case 23u: { v = vec4<u32>(0xef0df021u, 0xecb9edeau, 0xea34eb7cu, 0xe786e8e2u); }
        case 24u: { v = vec4<u32>(0xffe5ffffu, 0xf6e8fe23u, 0xe536ec06u, 0xe5fbe40eu); }
        case 25u: { v = vec4<u32>(0xeb92e8d4u, 0xef99edd9u, 0xf1aff0dau, 0xf24ff226u); }
        case 26u: { v = vec4<u32>(0xf1e1f235u, 0xf0a8f15au, 0xeed5efd0u, 0xec87edbcu); }
        case 27u: { v = vec4<u32>(0xe9d7eb3au, 0xe6d7e860u, 0xe398e53fu, 0xe025e1e4u); }
        case 28u: { v = vec4<u32>(0xfff1ffffu, 0xfad2ff06u, 0xe95ff22bu, 0xe3cae499u); }
        case 29u: { v = vec4<u32>(0xe75ce52fu, 0xeb67e98bu, 0xedd2ecd4u, 0xeea2ee68u); }
        case 30u: { v = vec4<u32>(0xee2cee8bu, 0xecbced90u, 0xea86ebb7u, 0xe7b5e92fu); }
        case 31u: { v = vec4<u32>(0xe468e61cu, 0xe0b8e29bu, 0xdcbadec2u, 0xd880daa4u); }
        case 32u: { v = vec4<u32>(0xfff7ffffu, 0xfcf5ff70u, 0xee81f6deu, 0xe410e79bu); }
        case 33u: { v = vec4<u32>(0xe455e362u, 0xe78ee5ebu, 0xe9fbe8f3u, 0xeae0ea9eu); }
        case 34u: { v = vec4<u32>(0xea5deac8u, 0xe8b1e9a8u, 0xe619e780u, 0xe2c4e483u); }
        case 35u: { v = vec4<u32>(0xded8e0dfu, 0xda76dcb4u, 0xd5b9d821u, 0xd0b6d33fu); }
        case 36u: { v = vec4<u32>(0xfffaffffu, 0xfe20ffa8u, 0xf328fa04u, 0xe64aebc4u); }
        case 37u: { v = vec4<u32>(0xe2cbe37cu, 0xe460e355u, 0xe65fe579u, 0xe72ce6f3u); }
        case 38u: { v = vec4<u32>(0xe689e707u, 0xe49ee5b9u, 0xe1a0e33eu, 0xddc6dfccu); }
        case 39u: { v = vec4<u32>(0xd93bdb94u, 0xd427d6c0u, 0xceaad174u, 0xc8e1cbceu); }
        case 40u: { v = vec4<u32>(0xfffcffffu, 0xfecaffc6u, 0xf6cafc05u, 0xe9a4effeu); }
        case 41u: { v = vec4<u32>(0xe2c8e52au, 0xe21de1fbu, 0xe331e2a3u, 0xe3a6e391u); }
        case 42u: { v = vec4<u32>(0xe2c9e365u, 0xe093e1d7u, 0xdd2cdf02u, 0xd8cadb17u); }
        case 43u: { v = vec4<u32>(0xd3a0d64bu, 0xcddbd0ceu, 0xc7a1cacau, 0xc115c463u); }
        case 44u: { v = vec4<u32>(0xfffdffffu, 0xff2fffd9u, 0xf96bfd49u, 0xed58f3b0u); }
        case 45u: { v = vec4<u32>(0xe410e7e1u, 0xe0e4e1e0u, 0xe09ce09bu, 0xe070e09du); }
        case 46u: { v = vec4<u32>(0xdf34dffcu, 0xdca2de16u, 0xd8cbdadcu, 0xd3e0d674u); }
        case 47u: { v = vec4<u32>(0xce16d113u, 0xc7a0caedu, 0xc0acc433u, 0xb962bd0fu); }
        case 48u: { v = vec4<u32>(0xfffdffffu, 0xff6effe4u, 0xfb42fe19u, 0xf0dcf6a6u); }
        case 49u: { v = vec4<u32>(0xe646eb12u, 0xe0b6e2dcu, 0xdec0df79u, 0xdda8de38u); }
        case 50u: { v = vec4<u32>(0xdbe1dce7u, 0xd8dbda88u, 0xd48ad6dau, 0xcf11d1efu); }
        case 51u: { v = vec4<u32>(0xc8a6cbf6u, 0xc181c527u, 0xb9d6bdb9u, 0xb1d4b5ddu); }
        case 52u: { v = vec4<u32>(0xfffeffffu, 0xff96ffebu, 0xfc88fea1u, 0xf3e9f8e8u); }
        case 53u: { v = vec4<u32>(0xe902ee4cu, 0xe176e4acu, 0xddaadf3au, 0xdb65dc79u); }
        case 54u: { v = vec4<u32>(0xd8e2da3du, 0xd54fd741u, 0xd075d30bu, 0xca68cd92u); }
        case 55u: { v = vec4<u32>(0xc35ac6fdu, 0xbb87bf86u, 0xb329b766u, 0xaa75aed7u); }
        case 56u: { v = vec4<u32>(0xfffeffffu, 0xffb1fff0u, 0xfd6afefcu, 0xf66afa97u); }
        case 57u: { v = vec4<u32>(0xebebf147u, 0xe2f3e703u, 0xdd5adfc8u, 0xd9b7db69u); }
        case 58u: { v = vec4<u32>(0xd64ad80fu, 0xd20bd44eu, 0xcc97cf79u, 0xc5edc967u); }
        case 59u: { v = vec4<u32>(0xbe3ac231u, 0xb5baba0fu, 0xacacb141u, 0xa34ca803u); }
        case 60u: { v = vec4<u32>(0xfffeffffu, 0xffc4fff4u, 0xfe09ff3bu, 0xf866fbd4u); }
        case 61u: { v = vec4<u32>(0xeebef3e1u, 0xe4f4e99cu, 0xddbee101u, 0xd8a6db07u); }
        case 62u: { v = vec4<u32>(0xd427d66au, 0xcf1bd1beu, 0xc8facc30u, 0xc1a9c576u); }
        case 63u: { v = vec4<u32>(0xb94bbd98u, 0xb01eb4cau, 0xa664ab4eu, 0x9c5ea167u); }
        default: {}
      }
    }
    case 1u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfffeffffu, 0xffd1fff6u, 0xfe7aff67u, 0xf9f2fcbeu); }
        case 1u: { v = vec4<u32>(0xf154f60eu, 0xe742ec3cu, 0xdebce2b7u, 0xd82fdb45u); }
        case 2u: { v = vec4<u32>(0xd280d551u, 0xcc89cf9bu, 0xc5a5c93au, 0xbda1c1c7u); }
        case 3u: { v = vec4<u32>(0xb493b938u, 0xaab7afbbu, 0xa054a592u, 0x95af9b05u); }
        case 4u: { v = vec4<u32>(0xffffffffu, 0xffdbfff8u, 0xfecdff87u, 0xfb24fd6bu); }
        case 5u: { v = vec4<u32>(0xf399f7d5u, 0xe9aceebdu, 0xe032e4c1u, 0xd849dc0fu); }
        case 6u: { v = vec4<u32>(0xd159d4c3u, 0xca5dcdebu, 0xc2a0c69eu, 0xb9dabe5fu); }
        case 7u: { v = vec4<u32>(0xb016b515u, 0xa589aae4u, 0x9a7fa00fu, 0x8f4194e2u); }
        case 8u: { v = vec4<u32>(0xffffffffu, 0xffe2fff9u, 0xff09ff9eu, 0xfc0efdecu); }
        case 9u: { v = vec4<u32>(0xf588f944u, 0xec0ef106u, 0xe1fde6f4u, 0xd8e3dd4au); }
        case 10u: { v = vec4<u32>(0xd0b1d4b8u, 0xc89bccafu, 0xbff1c460u, 0xb65abb44u); }
        case 11u: { v = vec4<u32>(0xabd5b133u, 0xa096a649u, 0x94e69ac7u, 0x89158efdu); }
        case 12u: { v = vec4<u32>(0xffffffffu, 0xffe7fffau, 0xff36ffb0u, 0xfcc4fe4eu); }
        case 13u: { v = vec4<u32>(0xf727fa69u, 0xee4ef30du, 0xe3fbe932u, 0xd9e9dedbu); }
        case 14u: { v = vec4<u32>(0xd080d524u, 0xc745cbe8u, 0xbd9ac286u, 0xb323b87au); }
        case 15u: { v = vec4<u32>(0xa7d5ad95u, 0x9bdea1eau, 0x8f8b95bbu, 0x832c8958u); }
        case 16u: { v = vec4<u32>(0xffffffffu, 0xffebfffbu, 0xff59ffbdu, 0xfd50fe99u); }
        case 17u: { v = vec4<u32>(0xf87dfb52u, 0xf05df4cdu, 0xe611eb5fu, 0xdb44e0a7u); }
        case 18u: { v = vec4<u32>(0xd0bed5f7u, 0xc65acb8fu, 0xbb9fc10eu, 0xb038b604u); }
        case 19u: { v = vec4<u32>(0xa416aa3du, 0x97639dcbu, 0x8a6c90ebu, 0x7d8583f2u); }
        case 20u: { v = vec4<u32>(0xffffffffu, 0xffeefffcu, 0xff73ffc8u, 0xfdbefed2u); }
        case 21u: { v = vec4<u32>(0xf996fc0bu, 0xf233f64cu, 0xe826ed6cu, 0xdcdde294u); }
        case 22u: { v = vec4<u32>(0xd15ed71du, 0xc5d6cb9eu, 0xba01bffau, 0xad9cb3e3u); }
        case 23u: { v = vec4<u32>(0xa09aa72du, 0x932599eau, 0x858a8c57u, 0x781f7ecau); }
        case 24u: { v = vec4<u32>(0xffffffffu, 0xfff0fffcu, 0xff88ffd0u, 0xfe14feffu); }
        case 25u: { v = vec4<u32>(0xfa7cfc9fu, 0xf3d0f78fu, 0xea29ef4eu, 0xdea0e48cu); }
        case 26u: { v = vec4<u32>(0xd250d885u, 0xc5b2cc09u, 0xb8bdbf45u, 0xab4eb216u); }
        case 27u: { v = vec4<u32>(0x9d61a465u, 0x8f249648u, 0x80e487ffu, 0x72fa79dfu); }
        case 28u: { v = vec4<u32>(0xffffffffu, 0xfff2fffdu, 0xff98ffd6u, 0xfe58ff22u); }
        case 29u: { v = vec4<u32>(0xfb38fd16u, 0xf536f89eu, 0xec0ef101u, 0xe079e680u); }
        case 30u: { v = vec4<u32>(0xd386da1du, 0xc5e7ccc6u, 0xb7d3beebu, 0xa94fb09eu); }
        case 31u: { v = vec4<u32>(0x9a6ba1e6u, 0x8b5e92e5u, 0x7c7883e1u, 0x6e127530u); }
        case 32u: { v = vec4<u32>(0xffffffffu, 0xfff4fffdu, 0xffa5ffdbu, 0xfe8eff3fu); }
        case 33u: { v = vec4<u32>(0xfbd1fd75u, 0xf66af980u, 0xedcef283u, 0xe257e861u); }
        case 34u: { v = vec4<u32>(0xd4f0dbd2u, 0xc66bcdc8u, 0xb73dbee5u, 0xa79daf79u); }
        case 35u: { v = vec4<u32>(0x97b99fb0u, 0x87d48fc1u, 0x78457ffcu, 0x696670bau); }
        case 36u: { v = vec4<u32>(0xffffffffu, 0xfff5fffdu, 0xffb0ffdfu, 0xfebaff55u); }
        case 37u: { v = vec4<u32>(0xfc4ffdc3u, 0xf771fa3du, 0xef66f3d6u, 0xe42fea28u); }
        case 38u: { v = vec4<u32>(0xd67fdd98u, 0xc734cf01u, 0xb6f8bf2du, 0xa638aea3u); }
        case 39u: { v = vec4<u32>(0x95489dc1u, 0x84838cdbu, 0x74497c4fu, 0x64f56c7du); }
        case 40u: { v = vec4<u32>(0xffffffffu, 0xfff6fffdu, 0xffb8ffe3u, 0xfedeff68u); }
        case 41u: { v = vec4<u32>(0xfcb7fe02u, 0xf851fadbu, 0xf0d4f4ffu, 0xe5f6ebceu); }
        case 42u: { v = vec4<u32>(0xd826df60u, 0xc838d065u, 0xb6febfb9u, 0xa51cae19u); }
        case 43u: { v = vec4<u32>(0x93199c18u, 0x816c8a31u, 0x708278d8u, 0x60bb6875u); }
        case 44u: { v = vec4<u32>(0xffffffffu, 0xfff7fffdu, 0xffbfffe5u, 0xfefbff77u); }
        case 45u: { v = vec4<u32>(0xfd0cfe36u, 0xf90ffb5fu, 0xf21af600u, 0xe7a5ed51u); }
        case 46u: { v = vec4<u32>(0xd9d9e121u, 0xc96cd1e8u, 0xb747c082u, 0xa448add6u); }
        case 47u: { v = vec4<u32>(0x912a9ab2u, 0x7e8c87c2u, 0x6cef7596u, 0x5cb764a1u); }
        case 48u: { v = vec4<u32>(0xffffffffu, 0xfff8fffeu, 0xffc5ffe8u, 0xff13ff83u); }
        case 49u: { v = vec4<u32>(0xfd54fe61u, 0xf9b1fbceu, 0xf33af6deu, 0xe939eeb1u); }
        case 50u: { v = vec4<u32>(0xdb8fe2d4u, 0xcac5d380u, 0xb7cec17eu, 0xa3b7add6u); }
        case 51u: { v = vec4<u32>(0x8f79998fu, 0x7be2858eu, 0x698d7287u, 0x58e660ffu); }
        case 52u: { v = vec4<u32>(0xffffffffu, 0xfff8fffeu, 0xffcaffeau, 0xff28ff8eu); }
        case 53u: { v = vec4<u32>(0xfd8ffe85u, 0xfa3bfc2bu, 0xf438f79eu, 0xeaaeefedu); }
        case 54u: { v = vec4<u32>(0xdd3ee472u, 0xcc39d523u, 0xb88ac2a4u, 0xa366ae12u); }
        case 55u: { v = vec4<u32>(0x8e0498abu, 0x796c8391u, 0x665a6fa9u, 0x55465d8cu); }
        case 56u: { v = vec4<u32>(0xffffffffu, 0xfff9fffeu, 0xffceffebu, 0xff38ff96u); }
        case 57u: { v = vec4<u32>(0xfdc1fea3u, 0xfab0fc7au, 0xf516f844u, 0xec04f109u); }
        case 58u: { v = vec4<u32>(0xdee1e5f8u, 0xcdc1d6c7u, 0xb975c3edu, 0xa350ae86u); }
        case 59u: { v = vec4<u32>(0x8cca9803u, 0x772881cbu, 0x63556cfbu, 0x51d45a46u); }
        case 60u: { v = vec4<u32>(0xffffffffu, 0xfff9fffeu, 0xffd1ffecu, 0xff46ff9eu); }
        case 61u: { v = vec4<u32>(0xfdebfebcu, 0xfb14fcbcu, 0xf5d9f8d3u, 0xed3bf205u); }
        case 62u: { v = vec4<u32>(0xe072e763u, 0xcf53d868u, 0xba87c550u, 0xa371af2au); }
        case 63u: { v = vec4<u32>(0x8bc79793u, 0x7516803au, 0x607c6a7au, 0x4e8e572bu); }
        default: {}
      }
    }
    case 2u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xfffeffffu, 0xffe1fff8u, 0xff47ffacu, 0xfdb0fea4u); }
        case 1u: { v = vec4<u32>(0xfa9afc5du, 0xf595f85bu, 0xee51f23eu, 0xe4a8e9cau); }
        case 2u: { v = vec4<u32>(0xd8a9def1u, 0xca96d1dcu, 0xbae1c2e7u, 0xaa1fb297u); }
        case 3u: { v = vec4<u32>(0x98f6a18du, 0x8803906du, 0x77cf7fcau, 0x68bd701du); }
        case 4u: { v = vec4<u32>(0xf8bbffffu, 0xd89aea44u, 0xb29cc5aau, 0x8ec7a02au); }
        case 5u: { v = vec4<u32>(0x700c7eb2u, 0x571a62ddu, 0x438e4cb3u, 0x34953b8du); }
        case 6u: { v = vec4<u32>(0x294a2e88u, 0x20d724c1u, 0x1a8c1d76u, 0x15dc1808u); }
        case 7u: { v = vec4<u32>(0x125c13fbu, 0x0fbb10f4u, 0x0dc00eacu, 0x0c3e0cf2u); }
        case 8u: { v = vec4<u32>(0xf383feaau, 0xda1feb4cu, 0xb38ac6e6u, 0x8f46a0d9u); }
        case 9u: { v = vec4<u32>(0x704d7f0du, 0x5739630au, 0x439a4cc7u, 0x34973b93u); }
        case 10u: { v = vec4<u32>(0x29462e86u, 0x20d124bcu, 0x1a841d6fu, 0x15d41800u); }
        case 11u: { v = vec4<u32>(0x125313f3u, 0x0fb210ebu, 0x0db60ea3u, 0x0c340ce8u); }
        case 12u: { v = vec4<u32>(0xf66dfab4u, 0xdaeee865u, 0xb586c8efu, 0x9086a27au); }
        case 13u: { v = vec4<u32>(0x70f77ffau, 0x57896381u, 0x43b74cfau, 0x34993ba2u); }
        case 14u: { v = vec4<u32>(0x293b2e81u, 0x20be24acu, 0x1a6e1d5au, 0x15bb17e8u); }
        case 15u: { v = vec4<u32>(0x123913d9u, 0x0f9710d0u, 0x0d9a0e87u, 0x0c160ccbu); }
        case 16u: { v = vec4<u32>(0xf2e4f435u, 0xd922e7feu, 0xb6cdc913u, 0x91dfa3fcu); }
        case 17u: { v = vec4<u32>(0x71c6810fu, 0x57ec6413u, 0x43d74d37u, 0x34933bacu); }
        case 18u: { v = vec4<u32>(0x29212e70u, 0x209b248du, 0x1a461d34u, 0x159017bfu); }
        case 19u: { v = vec4<u32>(0x120d13aeu, 0x0f6910a3u, 0x0d6a0e58u, 0x0be40c9au); }
        case 20u: { v = vec4<u32>(0xeac5eb58u, 0xd703e4afu, 0xb62bc72au, 0x9286a446u); }
        case 21u: { v = vec4<u32>(0x725881beu, 0x582e647eu, 0x43de4d59u, 0x34773b9eu); }
        case 22u: { v = vec4<u32>(0x28f22e48u, 0x20622458u, 0x1a091cf9u, 0x15521781u); }
        case 23u: { v = vec4<u32>(0x11ce136fu, 0x0f291063u, 0x0d280e17u, 0x0ba00c57u); }
        case 24u: { v = vec4<u32>(0xe006e055u, 0xd287dc8du, 0xb3a5c3d6u, 0x91d7a2cbu); }
        case 25u: { v = vec4<u32>(0x7244817du, 0x581a6472u, 0x43ae4d36u, 0x34313b62u); }
        case 26u: { v = vec4<u32>(0x28a12dfcu, 0x200e2406u, 0x19b41ca4u, 0x14fe172du); }
        case 27u: { v = vec4<u32>(0x117b131cu, 0x0ed51010u, 0x0cd30dc3u, 0x0b490c02u); }
        case 28u: { v = vec4<u32>(0xd340d370u, 0xca44d11cu, 0xaf5bbe3bu, 0x8f8c9f89u); }
        case 29u: { v = vec4<u32>(0x71337ff1u, 0x577663a7u, 0x43254ca4u, 0x33b23addu); }
        case 30u: { v = vec4<u32>(0x28262d7du, 0x1f97238du, 0x19441c31u, 0x149216bfu); }
        case 31u: { v = vec4<u32>(0x111212b2u, 0x0e6f0fa9u, 0x0c6d0d5du, 0x0ae20b9bu); }
        case 32u: { v = vec4<u32>(0xc4dbc4fau, 0xbec7c374u, 0xa8eeb5a4u, 0x8b9f9a80u); }
        case 33u: { v = vec4<u32>(0x6eef7cf4u, 0x561161e9u, 0x42244b7bu, 0x32e239fau); }
        case 34u: { v = vec4<u32>(0x27732cbeu, 0x1ef922e4u, 0x18b31b9au, 0x140c1634u); }
        case 35u: { v = vec4<u32>(0x10931230u, 0x0df50f2du, 0x0bf60ce5u, 0x0a6b0b24u); }
        case 36u: { v = vec4<u32>(0xb535b54au, 0xb103b441u, 0xa013aa49u, 0x8610938du); }
        case 37u: { v = vec4<u32>(0x6b6a7882u, 0x53cf5f1cu, 0x409649a1u, 0x31b438a2u); }
        case 38u: { v = vec4<u32>(0x267f2bb1u, 0x1e2b2205u, 0x18001adau, 0x136b158bu); }
        case 39u: { v = vec4<u32>(0x0ffe1196u, 0x0d690e9du, 0x0b6f0c5bu, 0x09e70a9fu); }
        case 40u: { v = vec4<u32>(0xa4afa4beu, 0xa1bda406u, 0x94f79cdau, 0x7eda8a9eu); }
        case 41u: { v = vec4<u32>(0x66a572a6u, 0x50a65b3bu, 0x3e684705u, 0x301c36cau); }
        case 42u: { v = vec4<u32>(0x25442a4du, 0x1d2b20eau, 0x172819f0u, 0x12ae14c0u); }
        case 43u: { v = vec4<u32>(0x0f5510e3u, 0x0ccb0dfau, 0x0adb0bc3u, 0x09580a0eu); }
        case 44u: { v = vec4<u32>(0x93ab93b6u, 0x91969334u, 0x881e8e0du, 0x760f7fe7u); }
        case 45u: { v = vec4<u32>(0x60b26b6eu, 0x4c995655u, 0x3b9a43abu, 0x2e17346cu); }
        case 46u: { v = vec4<u32>(0x23bd288eu, 0x1bf61f91u, 0x162918d9u, 0x11d513d8u); }
        case 47u: { v = vec4<u32>(0x0e951018u, 0x0c1e0d45u, 0x0a3a0b1du, 0x08c00971u); }
        case 48u: { v = vec4<u32>(0x82888290u, 0x81108235u, 0x7a247e86u, 0x6be873d4u); }
        case 49u: { v = vec4<u32>(0x59ad62fau, 0x47bb507du, 0x38323f9au, 0x2ba5318cu); }
        case 50u: { v = vec4<u32>(0x21eb2674u, 0x1a8d1df9u, 0x15061797u, 0x10e112ceu); }
        case 51u: { v = vec4<u32>(0x0dc30f36u, 0x0b630c7fu, 0x098f0a6au, 0x082108cdu); }
        case 52u: { v = vec4<u32>(0x71a371a8u, 0x709c7169u, 0x6ba16eceu, 0x60c066e8u); }
        case 53u: { v = vec4<u32>(0x51bc5987u, 0x422549d4u, 0x343f3aeau, 0x28cf2e36u); }
        case 54u: { v = vec4<u32>(0x1fd22407u, 0x18f31c26u, 0x13c0162bu, 0x0fd611a8u); }
        case 55u: { v = vec4<u32>(0x0cdf0e41u, 0x0a9c0babu, 0x08dc09aeu, 0x077d0823u); }
        case 56u: { v = vec4<u32>(0x614f6153u, 0x609b6128u, 0x5d195f5au, 0x550859aau); }
        case 57u: { v = vec4<u32>(0x491b4f66u, 0x3bfb4286u, 0x2fd935b5u, 0x25a22a7bu); }
        case 58u: { v = vec4<u32>(0x1d7c214fu, 0x172c1a1fu, 0x125c149au, 0x0eb51069u); }
        case 59u: { v = vec4<u32>(0x0bee0d39u, 0x09cc0accu, 0x082408ebu, 0x06d80775u); }
        case 60u: { v = vec4<u32>(0x51da51dcu, 0x516251c0u, 0x4efb5089u, 0x49314c8eu); }
        case 61u: { v = vec4<u32>(0x401144f6u, 0x35663acbu, 0x2b19301du, 0x22302670u); }
        case 62u: { v = vec4<u32>(0x1af21e5cu, 0x154217ebu, 0x10df12ecu, 0x0d840f15u); }
        case 63u: { v = vec4<u32>(0x0af20c25u, 0x08f609e4u, 0x076b0824u, 0x063306c6u); }
        default: {}
      }
    }
    case 3u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x43834384u, 0x43384373u, 0x41a342aau, 0x3da33ffdu); }
        case 1u: { v = vec4<u32>(0x36f03a96u, 0x2e9732deu, 0x26202a4bu, 0x1e8f2232u); }
        case 2u: { v = vec4<u32>(0x18441b3fu, 0x133d159au, 0x0f501127u, 0x0c470db3u); }
        case 3u: { v = vec4<u32>(0x09ef0b08u, 0x081d08f8u, 0x06b0075cu, 0x05910619u); }
        case 4u: { v = vec4<u32>(0x367d367eu, 0x36513674u, 0x355735fcu, 0x32b73447u); }
        case 5u: { v = vec4<u32>(0x2e04309du, 0x27c42b05u, 0x21112467u, 0x1ad51ddau); }
        case 6u: { v = vec4<u32>(0x1580180au, 0x11281335u, 0x0db70f55u, 0x0b040c48u); }
        case 7u: { v = vec4<u32>(0x08e909e6u, 0x0745080au, 0x05f90695u, 0x04f2056eu); }
        case 8u: { v = vec4<u32>(0x2aed2aedu, 0x2ad72ae9u, 0x2a4b2aa9u, 0x28b029a9u); }
        case 9u: { v = vec4<u32>(0x25952754u, 0x2124237eu, 0x1c0f1ea0u, 0x171a1987u); }
        case 10u: { v = vec4<u32>(0x12b714d2u, 0x0f0f10ccu, 0x0c1a0d7fu, 0x09c00adbu); }
        case 11u: { v = vec4<u32>(0x07e608c5u, 0x066f071fu, 0x054605d2u, 0x045a04cau); }
        case 12u: { v = vec4<u32>(0x20e820e8u, 0x20e020e7u, 0x20a020cdu, 0x1fc1204cu); }
        case 13u: { v = vec4<u32>(0x1ddd1ef4u, 0x1ae51c80u, 0x173e191fu, 0x13771557u); }
        case 14u: { v = vec4<u32>(0x0ffc11acu, 0x0cfc0e6bu, 0x0a820bafu, 0x08810974u); }
        case 15u: { v = vec4<u32>(0x06e707a8u, 0x05a0063au, 0x049b0516u, 0x03c9042cu); }
        case 16u: { v = vec4<u32>(0x18731873u, 0x18751874u, 0x18661872u, 0x18071846u); }
        case 17u: { v = vec4<u32>(0x1705179fu, 0x15351636u, 0x12bf1409u, 0x10041164u); }
        case 18u: { v = vec4<u32>(0x0d5b0ea9u, 0x0afc0c21u, 0x08f809eeu, 0x074d0817u); }
        case 19u: { v = vec4<u32>(0x05f20696u, 0x04d9055eu, 0x03f80462u, 0x03410398u); }
        case 20u: { v = vec4<u32>(0x11851185u, 0x118c1187u, 0x119b1193u, 0x118e119bu); }
        case 21u: { v = vec4<u32>(0x1126116au, 0x103010beu, 0x0ead0f7eu, 0x0cd40dc7u); }
        case 22u: { v = vec4<u32>(0x0ae60bdbu, 0x091809f9u, 0x07810845u, 0x062806cdu); }
        case 23u: { v = vec4<u32>(0x05090591u, 0x041e048eu, 0x035f03bau, 0x02c4030du); }
        case 24u: { v = vec4<u32>(0x0c080c08u, 0x0c110c0bu, 0x0c2e0c1du, 0x0c510c41u); }
        case 25u: { v = vec4<u32>(0x0c4a0c56u, 0x0bea0c28u, 0x0b1d0b90u, 0x09f70a92u); }
        case 26u: { v = vec4<u32>(0x08a80952u, 0x075907ffu, 0x062506bbu, 0x05170599u); }
        case 27u: { v = vec4<u32>(0x0431049eu, 0x037103ccu, 0x02d2031eu, 0x0250028eu); }
        case 28u: { v = vec4<u32>(0x07db07dau, 0x07e307ddu, 0x080507f1u, 0x083d0820u); }
        case 29u: { v = vec4<u32>(0x086c0858u, 0x08690873u, 0x0819084bu, 0x077c07d2u); }
        case 30u: { v = vec4<u32>(0x06ab0718u, 0x05c7063au, 0x04e80556u, 0x041d0480u); }
        case 31u: { v = vec4<u32>(0x036a03c0u, 0x02d2031bu, 0x0252028fu, 0x01e7021au); }
        case 32u: { v = vec4<u32>(0x04d104d1u, 0x04d904d3u, 0x04f904e5u, 0x05340513u); }
        case 33u: { v = vec4<u32>(0x05790557u, 0x05a80595u, 0x05a605aeu, 0x0567058du); }
        case 34u: { v = vec4<u32>(0x04f60533u, 0x046704b1u, 0x03d0041cu, 0x033d0385u); }
        case 35u: { v = vec4<u32>(0x02b802f9u, 0x0243027bu, 0x01de020eu, 0x018a01b2u); }
        case 36u: { v = vec4<u32>(0x02bb02bbu, 0x02c202bdu, 0x02dc02cbu, 0x031002f3u); }
        case 37u: { v = vec4<u32>(0x03560332u, 0x03980379u, 0x03be03b0u, 0x03b903c1u); }
        case 38u: { v = vec4<u32>(0x038a03a7u, 0x033c0366u, 0x02dd030eu, 0x027a02abu); }
        case 39u: { v = vec4<u32>(0x021b024au, 0x01c401eeu, 0x0178019du, 0x01370157u); }
        case 40u: { v = vec4<u32>(0x01660166u, 0x016b0167u, 0x017e0172u, 0x01a6018fu); }
        case 41u: { v = vec4<u32>(0x01e101c2u, 0x02210202u, 0x0255023eu, 0x026e0266u); }
        case 42u: { v = vec4<u32>(0x0268026fu, 0x0246025au, 0x0211022du, 0x01d301f3u); }
        case 43u: { v = vec4<u32>(0x019401b3u, 0x01570175u, 0x0120013bu, 0x00f00107u); }
        case 44u: { v = vec4<u32>(0x00a000a0u, 0x00a300a1u, 0x00af00a7u, 0x00cb00bbu); }
        case 45u: { v = vec4<u32>(0x00f600dfu, 0x0129010fu, 0x015a0142u, 0x017d016du); }
        case 46u: { v = vec4<u32>(0x018b0186u, 0x0184018au, 0x016c017au, 0x014a015cu); }
        case 47u: { v = vec4<u32>(0x01230136u, 0x00fb010fu, 0x00d500e8u, 0x00b300c4u); }
        case 48u: { v = vec4<u32>(0x003b003bu, 0x003c003bu, 0x0043003fu, 0x0053004au); }
        case 49u: { v = vec4<u32>(0x006e0060u, 0x0092007fu, 0x00b700a4u, 0x00d600c8u); }
        case 50u: { v = vec4<u32>(0x00eb00e2u, 0x00f200f0u, 0x00ec00f0u, 0x00dc00e5u); }
        case 51u: { v = vec4<u32>(0x00c600d2u, 0x00af00bbu, 0x009700a3u, 0x0080008bu); }
        case 52u: { v = vec4<u32>(0x00100010u, 0x00100010u, 0x00140012u, 0x001c0017u); }
        case 53u: { v = vec4<u32>(0x002a0022u, 0x003e0034u, 0x0056004au, 0x006d0062u); }
        case 54u: { v = vec4<u32>(0x007f0077u, 0x008a0085u, 0x008c008cu, 0x0088008bu); }
        case 55u: { v = vec4<u32>(0x007e0084u, 0x00720078u, 0x0064006bu, 0x0057005eu); }
        case 56u: { v = vec4<u32>(0x00020002u, 0x00030002u, 0x00040003u, 0x00070005u); }
        case 57u: { v = vec4<u32>(0x000d000au, 0x00160011u, 0x0022001cu, 0x00300029u); }
        case 58u: { v = vec4<u32>(0x003c0036u, 0x00450041u, 0x004a0048u, 0x004b004bu); }
        case 59u: { v = vec4<u32>(0x0048004au, 0x00430046u, 0x003d0040u, 0x0036003au); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00010001u); }
        case 61u: { v = vec4<u32>(0x00030002u, 0x00060005u, 0x000b0008u, 0x0010000eu); }
        case 62u: { v = vec4<u32>(0x00160013u, 0x001c0019u, 0x0020001eu, 0x00220021u); }
        case 63u: { v = vec4<u32>(0x00230023u, 0x00220022u, 0x00200021u, 0x001d001fu); }
        default: {}
      }
    }
    case 4u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00010001u, 0x00020001u, 0x00030002u); }
        case 2u: { v = vec4<u32>(0x00050004u, 0x00060005u, 0x00080007u, 0x00090009u); }
        case 3u: { v = vec4<u32>(0x000b000au, 0x000b000bu, 0x000c000bu, 0x000b000bu); }
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

fn bsdf_mf_lut_thin_film_rgb(elem_idx: u32) -> vec3<u32> {
  var v = vec3<u32>(0u);
  switch (elem_idx >> 6u) {
    case 0u: {
      switch (elem_idx & 63u) {
        case 0u: { v = vec3<u32>(0x00003c00u, 0x00003c00u, 0x00003c00u); }
        case 1u: { v = vec3<u32>(0xb1dc3bdeu, 0xb2d73bd1u, 0xb4393bb8u); }
        case 2u: { v = vec3<u32>(0xb5c33b77u, 0xb6af3b45u, 0xb8133ae4u); }
        case 3u: { v = vec3<u32>(0xb8333ad1u, 0xb8d23a64u, 0xb9c03993u); }
        case 4u: { v = vec3<u32>(0xb96139efu, 0xba143937u, 0xbb0637b9u); }
        case 5u: { v = vec3<u32>(0xba6138dau, 0xbb0f3798u, 0xbbcd3381u); }
        case 6u: { v = vec3<u32>(0xbb2a3736u, 0xbbb73466u, 0xbc04a7e4u); }
        case 7u: { v = vec3<u32>(0xbbb63479u, 0xbc022bfdu, 0xbbb1b4b6u); }
        case 8u: { v = vec3<u32>(0xbc002e4eu, 0xbbf1b0eau, 0xbacfb84eu); }
        case 9u: { v = vec3<u32>(0xbc02ad84u, 0xbb81b5cfu, 0xb973b9f5u); }
        case 10u: { v = vec3<u32>(0xbbc5b44cu, 0xbab7b873u, 0xb765bb31u); }
        case 11u: { v = vec3<u32>(0xbb42b714u, 0xb99db9cbu, 0xb2bbbbedu); }
        case 12u: { v = vec3<u32>(0xba80b8d1u, 0xb83fbadfu, 0x2b53bc0eu); }
        case 13u: { v = vec3<u32>(0xb985b9f0u, 0xb55cbba2u, 0x3526bbb9u); }
        case 14u: { v = vec3<u32>(0xb85abaddu, 0xafd7bc06u, 0x3885baccu); }
        case 15u: { v = vec3<u32>(0xb610bb90u, 0x2e2cbc0au, 0x3a27b964u); }
        case 16u: { v = vec3<u32>(0xb268bc02u, 0x34fdbbbeu, 0x3b5eb735u); }
        case 17u: { v = vec3<u32>(0xa2e6bc19u, 0x381bbb09u, 0x3c09b23cu); }
        case 18u: { v = vec3<u32>(0x3199bc0eu, 0x3989ba00u, 0x3c1c2cd3u); }
        case 19u: { v = vec3<u32>(0x35bebbbeu, 0x3ab5b8adu, 0x3bcd3576u); }
        case 20u: { v = vec3<u32>(0x3843bb1du, 0x3b93b642u, 0x3ad738aeu); }
        case 21u: { v = vec3<u32>(0x3984ba3du, 0x3c0bb1b4u, 0x39673a50u); }
        case 22u: { v = vec3<u32>(0x3a99b925u, 0x3c1c299fu, 0x372d3b84u); }
        case 23u: { v = vec3<u32>(0x3b78b7bau, 0x3bf7343du, 0x32143c1bu); }
        case 24u: { v = vec3<u32>(0x3c0cb4e0u, 0x3b553798u, 0xad483c2cu); }
        case 25u: { v = vec3<u32>(0x3c3aaf47u, 0x3a5a394du, 0xb59b3be8u); }
        case 26u: { v = vec3<u32>(0x3c432d59u, 0x39103a8fu, 0xb8c23aeeu); }
        case 27u: { v = vec3<u32>(0x3c27347du, 0x37103b83u, 0xba66397au); }
        case 28u: { v = vec3<u32>(0x3bcd3789u, 0x334c3c0eu, 0xbb9b374cu); }
        case 29u: { v = vec3<u32>(0x3b03392eu, 0x1a2d3c2au, 0xbc273248u); }
        case 30u: { v = vec3<u32>(0x39f93a70u, 0xb3223c13u, 0xbc38acf3u); }
        case 31u: { v = vec3<u32>(0x38b43b7du, 0xb7063b94u, 0xbc01b58au); }
        case 32u: { v = vec3<u32>(0x36803c26u, 0xb9143aa4u, 0xbb09b8bcu); }
        case 33u: { v = vec3<u32>(0x32a03c6au, 0xba683963u, 0xb998ba63u); }
        case 34u: { v = vec3<u32>(0x9a483c86u, 0xbb6e37beu, 0xb78cbb9cu); }
        case 35u: { v = vec3<u32>(0xb2f13c7au, 0xbc0d3455u, 0xb2cfbc29u); }
        case 36u: { v = vec3<u32>(0xb6d53c45u, 0xbc3129a4u, 0x2bb1bc3eu); }
        case 37u: { v = vec3<u32>(0xb9013bceu, 0xbc22b1ecu, 0x3542bc0au); }
        case 38u: { v = vec3<u32>(0xba713ac7u, 0xbbc0b67eu, 0x3899bb22u); }
        case 39u: { v = vec3<u32>(0xbbac397bu, 0xbadbb8dbu, 0x3a42b9b9u); }
        case 40u: { v = vec3<u32>(0xbc5337eau, 0xb9a3ba3bu, 0x3b80b7dfu); }
        case 41u: { v = vec3<u32>(0xbca93484u, 0xb824bb4fu, 0x3c1fb396u); }
        case 42u: { v = vec3<u32>(0xbcd42b14u, 0xb4e5bc04u, 0x3c382829u); }
        case 43u: { v = vec3<u32>(0xbcd3b1b3u, 0xad17bc2fu, 0x3c0a34c7u); }
        case 44u: { v = vec3<u32>(0xbca2b68du, 0x30d0bc26u, 0x3b31385au); }
        case 45u: { v = vec3<u32>(0xbc45b909u, 0x35f6bbd4u, 0x39d63a04u); }
        case 46u: { v = vec3<u32>(0xbb77baa4u, 0x389dbafbu, 0x381c3b46u); }
        case 47u: { v = vec3<u32>(0xba17bc03u, 0x3a04b9ccu, 0x34413c06u); }
        case 48u: { v = vec3<u32>(0xb875bc8fu, 0x3b1fb856u, 0x19113c25u); }
        case 49u: { v = vec3<u32>(0xb53fbcf1u, 0x3be1b557u, 0xb4243bffu); }
        case 50u: { v = vec3<u32>(0xad40bd24u, 0x3c20af0eu, 0xb8013b2eu); }
        case 51u: { v = vec3<u32>(0x317bbd25u, 0x3c1d2f84u, 0xb9a939e7u); }
        case 52u: { v = vec3<u32>(0x36c0bcf2u, 0x3bcd3569u, 0xbaee3843u); }
        case 53u: { v = vec3<u32>(0x3948bc8cu, 0x3b003855u, 0xbbbd34b8u); }
        case 54u: { v = vec3<u32>(0x3b02bbefu, 0x39dd39bcu, 0xbc042943u); }
        case 55u: { v = vec3<u32>(0x3c3eba71u, 0x38743adau, 0xbbceb2c9u); }
        case 56u: { v = vec3<u32>(0x3cd2b8adu, 0x35ac3ba1u, 0xbb13b72bu); }
        case 57u: { v = vec3<u32>(0x3d37b564u, 0x30643c04u, 0xb9e6b937u); }
        case 58u: { v = vec3<u32>(0x3d68acaeu, 0xad703c05u, 0xb85cba7cu); }
        case 59u: { v = vec3<u32>(0x3d62324bu, 0xb4d03ba9u, 0xb522bb50u); }
        case 60u: { v = vec3<u32>(0x3d253763u, 0xb8003ae9u, 0xad14bba8u); }
        case 61u: { v = vec3<u32>(0x3cb239afu, 0xb96239d7u, 0x3136bb81u); }
        case 62u: { v = vec3<u32>(0x3c0d3b77u, 0xba7d3880u, 0x363ebadeu); }
        case 63u: { v = vec3<u32>(0x3a793c7bu, 0xbb4535eau, 0x38b5b9ceu); }
        default: {}
      }
    }
    case 1u: {
      switch (elem_idx & 63u) {
        case 0u: { v = vec3<u32>(0x38923d0du, 0xbbb0312au, 0x39f4b863u); }
        case 1u: { v = vec3<u32>(0x34f13d6bu, 0xbbbbaa9du, 0x3accb56fu); }
        case 2u: { v = vec3<u32>(0x28173d91u, 0xbb67b426u, 0x3b2faf44u); }
        case 3u: { v = vec3<u32>(0xb3ec3d7eu, 0xbab9b738u, 0x3b192f5bu); }
        case 4u: { v = vec3<u32>(0xb8253d30u, 0xb9bbb8f3u, 0x3a8f354bu); }
        case 5u: { v = vec3<u32>(0xba253cacu, 0xb87bba07u, 0x399d382au); }
        case 6u: { v = vec3<u32>(0xbbe63bedu, 0xb612bacdu, 0x38543960u); }
        case 7u: { v = vec3<u32>(0xbcaa3a2eu, 0xb1e2bb3cu, 0x35983a36u); }
        case 8u: { v = vec3<u32>(0xbd31382eu, 0x244fbb50u, 0x307f3aa0u); }
        case 9u: { v = vec3<u32>(0xbd803402u, 0x32d0bb0bu, 0xac9b3a9bu); }
        case 10u: { v = vec3<u32>(0xbd95a7f4u, 0x3652ba71u, 0xb4623a28u); }
        case 11u: { v = vec3<u32>(0xbd6fb4f9u, 0x3870b98bu, 0xb73e3954u); }
        case 12u: { v = vec3<u32>(0xbd10b89du, 0x3979b868u, 0xb8c7382du); }
        case 13u: { v = vec3<u32>(0xbc7cba8bu, 0x3a3bb629u, 0xb9973595u); }
        case 14u: { v = vec3<u32>(0xbb71bc19u, 0x3aacb291u, 0xba053111u); }
        case 15u: { v = vec3<u32>(0xb99fbcbfu, 0x3acba50du, 0xba0ba8adu); }
        case 16u: { v = vec3<u32>(0xb728bd32u, 0x3a963130u, 0xb9aeb321u); }
        case 17u: { v = vec3<u32>(0xb19ebd6du, 0x3a133550u, 0xb8f5b638u); }
        case 18u: { v = vec3<u32>(0x2e7abd6fu, 0x394b37b5u, 0xb7e1b831u); }
        case 19u: { v = vec3<u32>(0x35f0bd37u, 0x384838d7u, 0xb566b8f7u); }
        case 20u: { v = vec3<u32>(0x38fcbcc8u, 0x36333993u, 0xb14fb963u); }
        case 21u: { v = vec3<u32>(0x3ac5bc28u, 0x33373a07u, 0x2155b972u); }
        case 22u: { v = vec3<u32>(0x3c20babcu, 0x2b613a30u, 0x31c0b926u); }
        case 23u: { v = vec3<u32>(0x3cb0b8e7u, 0xaeea3a0eu, 0x354cb886u); }
        case 24u: { v = vec3<u32>(0x3d0db5c8u, 0xb43839a5u, 0x3748b742u); }
        case 25u: { v = vec3<u32>(0x3d33ae57u, 0xb67138fdu, 0x385cb510u); }
        case 26u: { v = vec3<u32>(0x3d22313au, 0xb826381fu, 0x38c3b13bu); }
        case 27u: { v = vec3<u32>(0x3cdb36a2u, 0xb8db3630u, 0x38d69e12u); }
        case 28u: { v = vec3<u32>(0x3c623928u, 0xb95233d3u, 0x389730aau); }
        case 29u: { v = vec3<u32>(0x3b7c3ac0u, 0xb9862e24u, 0x380d3482u); }
        case 30u: { v = vec3<u32>(0x39eb3c05u, 0xb978aaaau, 0x3689364cu); }
        case 31u: { v = vec3<u32>(0x38253c7du, 0xb92bb22au, 0x349a3799u); }
        case 32u: { v = vec3<u32>(0x34793cc3u, 0xb8a5b51du, 0x30e1382bu); }
        case 33u: { v = vec3<u32>(0x28783cd7u, 0xb7ddb6d8u, 0x22ab383fu); }
        case 34u: { v = vec3<u32>(0xb2963cb8u, 0xb621b81au, 0xafc43809u); }
        case 35u: { v = vec3<u32>(0xb6ec3c68u, 0xb430b893u, 0xb3bc3722u); }
        case 36u: { v = vec3<u32>(0xb9183bdbu, 0xb043b8d3u, 0xb57335c2u); }
        case 37u: { v = vec3<u32>(0xba7b3a9au, 0x9b2db8dau, 0xb699340eu); }
        case 38u: { v = vec3<u32>(0xbb93391du, 0x2fc5b8a9u, 0xb7403050u); }
        case 39u: { v = vec3<u32>(0xbc2b36eau, 0x338fb846u, 0xb7622247u); }
        case 40u: { v = vec3<u32>(0xbc5f32d5u, 0x3561b76eu, 0xb703aec0u); }
        case 41u: { v = vec3<u32>(0xbc66a010u, 0x36aeb607u, 0xb62eb2beu); }
        case 42u: { v = vec3<u32>(0xbc3fb323u, 0x37a4b46bu, 0xb4f7b4c0u); }
        case 43u: { v = vec3<u32>(0xbbddb6c6u, 0x381db15eu, 0xb2efb5bdu); }
        case 44u: { v = vec3<u32>(0xbaf1b8cfu, 0x3838ab37u, 0xaf35b64au); }
        case 45u: { v = vec3<u32>(0xb9c5ba00u, 0x38242ac7u, 0x9dc4b662u); }
        case 46u: { v = vec3<u32>(0xb869baecu, 0x37c630fau, 0x2e31b608u); }
        case 47u: { v = vec3<u32>(0xb5d4bb8cu, 0x36f433eau, 0x3202b548u); }
        case 48u: { v = vec3<u32>(0xb168bbdbu, 0x35df3533u, 0x342fb433u); }
        case 49u: { v = vec3<u32>(0x26eebbdau, 0x3497362bu, 0x3504b1c2u); }
        case 50u: { v = vec3<u32>(0x32e9bb8bu, 0x325436d7u, 0x3576adacu); }
        case 51u: { v = vec3<u32>(0x3640baf3u, 0x2eaa3732u, 0x35821cc2u); }
        case 52u: { v = vec3<u32>(0x385cba1cu, 0x211b373du, 0x352a2df8u); }
        case 53u: { v = vec3<u32>(0x3963b910u, 0xad2b36fbu, 0x3479317bu); }
        case 54u: { v = vec3<u32>(0x3a2cb7b5u, 0xb1433671u, 0x33003379u); }
        case 55u: { v = vec3<u32>(0x3ab3b512u, 0xb39d35aau, 0x30a6346du); }
        case 56u: { v = vec3<u32>(0x3af5b0a8u, 0xb4c834aeu, 0x2c2834c5u); }
        case 57u: { v = vec3<u32>(0x3af126a1u, 0xb5853318u, 0xa43334c2u); }
        case 58u: { v = vec3<u32>(0x3aaa321bu, 0xb60130a1u, 0xadf23469u); }
        case 59u: { v = vec3<u32>(0x3a25357eu, 0xb63a2c26u, 0xb1193388u); }
        case 60u: { v = vec3<u32>(0x396937a6u, 0xb630a370u, 0xb2c531c3u); }
        case 61u: { v = vec3<u32>(0x387f38b9u, 0xb5e7adc7u, 0xb3e12f51u); }
        case 62u: { v = vec3<u32>(0x36e5396bu, 0xb564b11au, 0xb431298bu); }
        case 63u: { v = vec3<u32>(0x349a39e3u, 0xb4aeb307u, 0xb421a71au); }
        default: {}
      }
    }
    case 2u: {
      switch (elem_idx & 63u) {
        case 0u: { v = vec3<u32>(0x306c3a20u, 0xb3a0b44du, 0xb38eae00u); }
        case 1u: { v = vec3<u32>(0xa1fe3a21u, 0xb1a5b4e3u, 0xb255b0cfu); }
        case 2u: { v = vec3<u32>(0xb10139e7u, 0xaf06b542u, 0xb0b6b232u); }
        case 3u: { v = vec3<u32>(0xb4a73978u, 0xa942b568u, 0xada3b314u); }
        case 4u: { v = vec3<u32>(0xb69138d8u, 0x26dcb556u, 0xa669b36bu); }
        case 5u: { v = vec3<u32>(0xb8173810u, 0x2dd7b50eu, 0x28c4b336u); }
        case 6u: { v = vec3<u32>(0xb8b93650u, 0x30ccb495u, 0x2e09b27fu); }
        case 7u: { v = vec3<u32>(0xb9293452u, 0x326cb3e3u, 0x308eb157u); }
        case 8u: { v = vec3<u32>(0xb9663074u, 0x33bdb257u, 0x31b4afb2u); }
        case 9u: { v = vec3<u32>(0xb96f1f63u, 0x345ab097u, 0x3266ac47u); }
        case 10u: { v = vec3<u32>(0xb944afc1u, 0x34a6ad6du, 0x329ba178u); }
        case 11u: { v = vec3<u32>(0xb8e9b3bau, 0x34bfa64eu, 0x325529a3u); }
        case 12u: { v = vec3<u32>(0xb863b597u, 0x34a82870u, 0x319e2dfcu); }
        case 13u: { v = vec3<u32>(0xb76eb710u, 0x34612dcfu, 0x3087304du); }
        case 14u: { v = vec3<u32>(0xb5dbb81eu, 0x33e03087u, 0x2e4f3140u); }
        case 15u: { v = vec3<u32>(0xb41db88au, 0x32b431ecu, 0x2a7231cau); }
        case 16u: { v = vec3<u32>(0xb087b8c8u, 0x314c3309u, 0x0d8931e6u); }
        case 17u: { v = vec3<u32>(0xa627b8d7u, 0x2f6e33d6u, 0xaa1e3194u); }
        case 18u: { v = vec3<u32>(0x2dd5b8b8u, 0x2c113425u, 0xadcd30e1u); }
        case 19u: { v = vec3<u32>(0x3265b86eu, 0x21123433u, 0xb0042fb8u); }
        case 20u: { v = vec3<u32>(0x34c5b7f9u, 0xa9723415u, 0xb0cd2d36u); }
        case 21u: { v = vec3<u32>(0x3620b6d0u, 0xadde339au, 0xb13828deu); }
        case 22u: { v = vec3<u32>(0x3738b56fu, 0xb05732beu, 0xb1419e85u); }
        case 23u: { v = vec3<u32>(0x3802b3c7u, 0xb18631a3u, 0xb0eaaa38u); }
        case 24u: { v = vec3<u32>(0x383fb07du, 0xb2733054u, 0xb03ead7cu); }
        case 25u: { v = vec3<u32>(0x3852a87bu, 0xb3132dc5u, 0xae9baf61u); }
        case 26u: { v = vec3<u32>(0x383c2c65u, 0xb3642977u, 0xac57b057u); }
        case 27u: { v = vec3<u32>(0x37fb3157u, 0xb3649d30u, 0xa771b0aau); }
        case 28u: { v = vec3<u32>(0x37363419u, 0xb315aa8au, 0x2129b0a5u); }
        case 29u: { v = vec3<u32>(0x36323556u, 0xb27dadfcu, 0x2a00b04eu); }
        case 30u: { v = vec3<u32>(0x34fa3656u, 0xb1a4b02du, 0x2d0baf5bu); }
        case 31u: { v = vec3<u32>(0x33363712u, 0xb096b126u, 0x2ea6ada6u); }
        case 32u: { v = vec3<u32>(0x30473785u, 0xaec0b1deu, 0x2fb9ab40u); }
        case 33u: { v = vec3<u32>(0x291637adu, 0xac21b251u, 0x301ba5c4u); }
        case 34u: { v = vec3<u32>(0xaac63789u, 0xa5b5b27bu, 0x300e21efu); }
        case 35u: { v = vec3<u32>(0xb081371eu, 0x24f1b25du, 0x2f74298bu); }
        case 36u: { v = vec3<u32>(0xb30f3672u, 0x2b7db1fbu, 0x2e502c83u); }
        case 37u: { v = vec3<u32>(0xb4a3358du, 0x2dffb15cu, 0x2ccb2ddcu); }
        case 38u: { v = vec3<u32>(0xb5883479u, 0x2fe7b088u, 0x2a092ebcu); }
        case 39u: { v = vec3<u32>(0xb6303287u, 0x30b2af18u, 0x247f2f1au); }
        case 40u: { v = vec3<u32>(0xb6972fe2u, 0x3135ace7u, 0xa1fd2ef5u); }
        case 41u: { v = vec3<u32>(0xb6bb292du, 0x317aa932u, 0xa8f12e58u); }
        case 42u: { v = vec3<u32>(0xb69da940u, 0x317f9c89u, 0xabdc2d54u); }
        case 43u: { v = vec3<u32>(0xb63faf8fu, 0x314827bfu, 0xad092c00u); }
        case 44u: { v = vec3<u32>(0xb5a9b204u, 0x30d92bf0u, 0xadbc28f2u); }
        case 45u: { v = vec3<u32>(0xb4e2b3f1u, 0x303a2dbbu, 0xadff22e9u); }
        case 46u: { v = vec3<u32>(0xb3e6b4c0u, 0x2eea2f29u, 0xadd4a1adu); }
        case 47u: { v = vec3<u32>(0xb1cdb552u, 0x2d28301bu, 0xad45a847u); }
        case 48u: { v = vec3<u32>(0xaf24b5acu, 0x2a8b306du, 0xac62aaa9u); }
        case 49u: { v = vec3<u32>(0xa929b5cbu, 0x25623089u, 0xaa7fac37u); }
        case 50u: { v = vec3<u32>(0x2795b5b2u, 0xa03a3073u, 0xa7daacc1u); }
        case 51u: { v = vec3<u32>(0x2e1eb563u, 0xa88b302cu, 0xa106acecu); }
        case 52u: { v = vec3<u32>(0x30f8b4e4u, 0xaba12f7au, 0x2146acbdu); }
        case 53u: { v = vec3<u32>(0x329eb43cu, 0xad1a2e56u, 0x273dac3du); }
        case 54u: { v = vec3<u32>(0x33f3b2e5u, 0xae162d00u, 0x2980aaf4u); }
        case 55u: { v = vec3<u32>(0x3477b122u, 0xaec02b12u, 0x2adca90fu); }
        case 56u: { v = vec3<u32>(0x34c5ae86u, 0xaf152809u, 0x2ba1a5e6u); }
        case 57u: { v = vec3<u32>(0x34e2a969u, 0xaf18202bu, 0x2bcd9e64u); }
        case 58u: { v = vec3<u32>(0x34d0242bu, 0xaecea325u, 0x2b6820f2u); }
        case 59u: { v = vec3<u32>(0x34932c94u, 0xae40a855u, 0x2a842608u); }
        case 60u: { v = vec3<u32>(0x342e2fcau, 0xad7aaa82u, 0x293c286eu); }
        case 61u: { v = vec3<u32>(0x334d3149u, 0xac89ac20u, 0x27602966u); }
        case 62u: { v = vec3<u32>(0x3208326bu, 0xaaf5acc1u, 0x240629e4u); }
        case 63u: { v = vec3<u32>(0x309b3345u, 0xa8bcad23u, 0x197929e8u); }
        default: {}
      }
    }
    case 3u: {
      switch (elem_idx & 63u) {
        case 0u: { v = vec3<u32>(0x2e2b33d3u, 0xa500ad47u, 0xa0c7297du); }
        case 1u: { v = vec3<u32>(0x2a1c3409u, 0x99c3ad31u, 0xa4fc28b3u); }
        case 2u: { v = vec3<u32>(0x8cb43403u, 0x226cace8u, 0xa6f22745u); }
        case 3u: { v = vec3<u32>(0xa9e333b4u, 0x26a8ac74u, 0xa81724d0u); }
        case 4u: { v = vec3<u32>(0xada03320u, 0x28c3abbcu, 0xa853207du); }
        case 5u: { v = vec3<u32>(0xaffb3255u, 0x29dfaa60u, 0xa83292f5u); }
        case 6u: { v = vec3<u32>(0xb0fa315cu, 0x2aa6a8e8u, 0xa77ea0c5u); }
        case 7u: { v = vec3<u32>(0xb1bf3040u, 0x2b18a6ceu, 0xa618a41cu); }
        case 8u: { v = vec3<u32>(0xb2492e1au, 0x2b3da3b7u, 0xa45da549u); }
        case 9u: { v = vec3<u32>(0xb2972b39u, 0x2b1a9c55u, 0xa0f2a5e0u); }
        case 10u: { v = vec3<u32>(0xb2a82476u, 0x2abb1db8u, 0x98d8a5e1u); }
        case 11u: { v = vec3<u32>(0xb281a537u, 0x2a2c233cu, 0x1c4da55cu); }
        case 12u: { v = vec3<u32>(0xb224ab24u, 0x29792571u, 0x20e0a46au); }
        case 13u: { v = vec3<u32>(0xb198ad9fu, 0x28ad26e3u, 0x22c5a259u); }
        case 14u: { v = vec3<u32>(0xb0e4af66u, 0x27a727f4u, 0x23be9f23u); }
        case 15u: { v = vec3<u32>(0xb00eb06eu, 0x25ed2856u, 0x23c89655u); }
        case 16u: { v = vec3<u32>(0xae41b0fdu, 0x243b2888u, 0x22fa1ad4u); }
        case 17u: { v = vec3<u32>(0xac45b15eu, 0x21382897u, 0x217a1f65u); }
        case 18u: { v = vec3<u32>(0xa875b18fu, 0x1c662888u, 0x1f022103u); }
        case 19u: { v = vec3<u32>(0x9a20b191u, 0x947e2860u, 0x1936218eu); }
        case 20u: { v = vec3<u32>(0x271db165u, 0x9e192825u, 0x96f42154u); }
        case 21u: { v = vec3<u32>(0x2b3fb110u, 0xa14327b4u, 0x9d8a2065u); }
        case 22u: { v = vec3<u32>(0x2d4ab094u, 0xa3372707u, 0xa0321dc9u); }
        case 23u: { v = vec3<u32>(0x2ebdafeeu, 0xa4772646u, 0xa0ff1811u); }
        case 24u: { v = vec3<u32>(0x2feeae7eu, 0xa5352576u, 0xa119980au); }
        case 25u: { v = vec3<u32>(0x306bace4u, 0xa5d82497u, 0xa07e9de6u); }
        case 26u: { v = vec3<u32>(0x30b8aa5cu, 0xa65f2353u, 0x9e7fa095u); }
        case 27u: { v = vec3<u32>(0x30dca5a7u, 0xa6cc215du, 0x9a00a1b7u); }
        case 28u: { v = vec3<u32>(0x30d81daeu, 0xa71a1e96u, 0x148aa236u); }
        case 29u: { v = vec3<u32>(0x30ac2824u, 0xa7471882u, 0x1d78a1ffu); }
        case 30u: { v = vec3<u32>(0x305b2b5bu, 0xa7509878u, 0x20c5a111u); }
        case 31u: { v = vec3<u32>(0x2fd02d22u, 0xa72f9ed1u, 0x22759efdu); }
        case 32u: { v = vec3<u32>(0x2eae2e65u, 0xa6e2a1b4u, 0x239999a7u); }
        case 33u: { v = vec3<u32>(0x2d592f6bu, 0xa665a3f2u, 0x240717f2u); }
        case 34u: { v = vec3<u32>(0x2bbc3017u, 0xa5b7a508u, 0x23be1f00u); }
        case 35u: { v = vec3<u32>(0x28923054u, 0xa4d8a5feu, 0x22aa21deu); }
        case 36u: { v = vec3<u32>(0x2141306cu, 0xa395a6d1u, 0x20df23deu); }
        case 37u: { v = vec3<u32>(0xa3ba305du, 0xa129a776u, 0x1d0124a5u); }
        case 38u: { v = vec3<u32>(0xa90f3029u, 0x9cf5a7e5u, 0x901c24fdu); }
        case 39u: { v = vec3<u32>(0xabf62fa4u, 0x121ea80au, 0x9e5a24eau); }
        case 40u: { v = vec3<u32>(0xad462eb6u, 0x1ea7a800u, 0xa2012469u); }
        case 41u: { v = vec3<u32>(0xae5d2d91u, 0x2240a7a4u, 0xa43e2301u); }
        case 42u: { v = vec3<u32>(0xaf382c40u, 0x2485a701u, 0xa533207eu); }
        case 43u: { v = vec3<u32>(0xafcf299du, 0x25caa619u, 0xa5c619e5u); }
        case 44u: { v = vec3<u32>(0xb00f2529u, 0x26e1a4f3u, 0xa5e79b46u); }
        case 45u: { v = vec3<u32>(0xb0129be1u, 0x27bda331u, 0xa58ea11fu); }
        case 46u: { v = vec3<u32>(0xafe0a6feu, 0x282aa02bu, 0xa4bfa415u); }
        case 47u: { v = vec3<u32>(0xaf57aa54u, 0x284f978au, 0xa30ca557u); }
        case 48u: { v = vec3<u32>(0xae8dac71u, 0x284b1cbbu, 0x9fe1a63au); }
        case 49u: { v = vec3<u32>(0xad8bad8au, 0x281e219fu, 0x925fa6a9u); }
        case 50u: { v = vec3<u32>(0xac5bae6cu, 0x27912459u, 0x1e9ca695u); }
        case 51u: { v = vec3<u32>(0xaa12af0fu, 0x269b25bbu, 0x22e2a5feu); }
        case 52u: { v = vec3<u32>(0xa686af6du, 0x256326e8u, 0x2506a4eau); }
        case 53u: { v = vec3<u32>(0x9a35af86u, 0x23ec27d2u, 0x2645a2d8u); }
        case 54u: { v = vec3<u32>(0x24e3af58u, 0x20c22838u, 0x27119e7bu); }
        case 55u: { v = vec3<u32>(0x2921aee7u, 0x19a3285eu, 0x275a15bau); }
        case 56u: { v = vec3<u32>(0x2b92ae39u, 0x9bf62859u, 0x271420bbu); }
        case 57u: { v = vec3<u32>(0x2cd8ad54u, 0xa14f282au, 0x2643243fu); }
        case 58u: { v = vec3<u32>(0x2db4ac43u, 0xa43527a4u, 0x24f225dau); }
        case 59u: { v = vec3<u32>(0x2e56aa21u, 0xa59726abu, 0x2274270eu); }
        case 60u: { v = vec3<u32>(0x2eb9a71fu, 0xa6c22572u, 0x1ce327c1u); }
        case 61u: { v = vec3<u32>(0x2edc9f63u, 0xa7a92406u, 0x9b5d27e3u); }
        case 62u: { v = vec3<u32>(0x2ebd22bfu, 0xa82220ebu, 0xa215276eu); }
        case 63u: { v = vec3<u32>(0x2e60282cu, 0xa8471a7du, 0xa4fa2668u); }
        default: {}
      }
    }
    case 4u: {
      switch (elem_idx & 63u) {
        case 0u: { v = vec3<u32>(0x2dc92a72u, 0xa8439ad9u, 0xa69524e3u); }
        case 1u: { v = vec3<u32>(0x2d012c37u, 0xa815a0f5u, 0xa7ba21f1u); }
        case 2u: { v = vec3<u32>(0x2c0e2d07u, 0xa781a3fdu, 0xa8291a66u); }
        case 3u: { v = vec3<u32>(0x29f72da3u, 0xa691a55au, 0xa8279de1u); }
        case 4u: { v = vec3<u32>(0x274f2e06u, 0xa564a67fu, 0xa7aca357u); }
        case 5u: { v = vec3<u32>(0x21162e2eu, 0xa404a763u, 0xa678a5a2u); }
        case 6u: { v = vec3<u32>(0xa0632e1bu, 0xa102a7ffu, 0xa4c4a737u); }
        case 7u: { v = vec3<u32>(0xa6ba2dcfu, 0x9b40a827u, 0xa160a825u); }
        case 8u: { v = vec3<u32>(0xa9732d50u, 0x19b9a826u, 0x961aa863u); }
        case 9u: { v = vec3<u32>(0xab472ca1u, 0x209aa7f9u, 0x1ff0a84fu); }
        case 10u: { v = vec3<u32>(0xac662b99u, 0x2396a75bu, 0x243da7d5u); }
        case 11u: { v = vec3<u32>(0xacf929b3u, 0x2523a676u, 0x2636a677u); }
        case 12u: { v = vec3<u32>(0xad5b274au, 0x2647a554u, 0x27c1a49cu); }
        case 13u: { v = vec3<u32>(0xad872209u, 0x272ea3feu, 0x2861a0cdu); }
        case 14u: { v = vec3<u32>(0xad7f9cfeu, 0x27cea107u, 0x289102a5u); }
        case 15u: { v = vec3<u32>(0xad43a55bu, 0x28119b84u, 0x286d20e4u); }
        case 16u: { v = vec3<u32>(0xacd8a895u, 0x2813195bu, 0x27ed24bbu); }
        case 17u: { v = vec3<u32>(0xac42aa44u, 0x27d92081u, 0x266d26b1u); }
        case 18u: { v = vec3<u32>(0xab10abadu, 0x273e237eu, 0x24722819u); }
        case 19u: { v = vec3<u32>(0xa963ac62u, 0x265b2518u, 0x2043288fu); }
        case 20u: { v = vec3<u32>(0xa71dacc1u, 0x2538263fu, 0x95b328b3u); }
        case 21u: { v = vec3<u32>(0xa293acf1u, 0x23bf2726u, 0xa1ac2881u); }
        case 22u: { v = vec3<u32>(0x1880acf0u, 0x20bf27c6u, 0xa52227f8u); }
        case 23u: { v = vec3<u32>(0x244bacc1u, 0x1a35280bu, 0xa713265cu); }
        case 24u: { v = vec3<u32>(0x27c4ac66u, 0x9ad92809u, 0xa8442449u); }
        case 25u: { v = vec3<u32>(0x296eabc8u, 0xa0ea27bbu, 0xa8b11f93u); }
        case 26u: { v = vec3<u32>(0x2abdaa80u, 0xa3eb2713u, 0xa8ca9924u); }
        case 27u: { v = vec3<u32>(0x2bc3a903u, 0xa54d2620u, 0xa88ca24au); }
        case 28u: { v = vec3<u32>(0x2c3ca6bdu, 0xa66e24ecu, 0xa7f7a56fu); }
        case 29u: { v = vec3<u32>(0x2c6ba295u, 0xa7492304u, 0xa646a759u); }
        case 30u: { v = vec3<u32>(0x2c6f1239u, 0xa7d71fcau, 0xa422a860u); }
        case 31u: { v = vec3<u32>(0x2c48232au, 0xa80814d8u, 0x9ec9a8c5u); }
        case 32u: { v = vec3<u32>(0x2bf126c0u, 0xa7f19d6cu, 0x1ae7a8d5u); }
        case 33u: { v = vec3<u32>(0x2b0928cau, 0xa77ba1e9u, 0x22bba88eu); }
        case 34u: { v = vec3<u32>(0x29e329fcu, 0xa6b2a46du, 0x25a2a7ebu); }
        case 35u: { v = vec3<u32>(0x288a2aebu, 0xa59fa5b4u, 0x2783a62cu); }
        case 36u: { v = vec3<u32>(0x261d2b90u, 0xa44ea6bbu, 0x286ea3fdu); }
        case 37u: { v = vec3<u32>(0x21fb2be6u, 0xa199a775u, 0x28cc9e2bu); }
        case 38u: { v = vec3<u32>(0x912d2becu, 0x9cb4a7d9u, 0x28d51c0fu); }
        case 39u: { v = vec3<u32>(0xa2712ba3u, 0x17dfa7e4u, 0x288722feu); }
        case 40u: { v = vec3<u32>(0xa6112b10u, 0x2042a795u, 0x27d325bbu); }
        case 41u: { v = vec3<u32>(0xa84c2a3bu, 0x2353a6eeu, 0x260d278fu); }
        case 42u: { v = vec3<u32>(0xa95c292eu, 0x2504a5f9u, 0x23bd286eu); }
        case 43u: { v = vec3<u32>(0xaa2d27e9u, 0x2622a4bfu, 0x1db628c6u); }
        case 44u: { v = vec3<u32>(0xaab92539u, 0x26f6a2a3u, 0x9c6828c9u); }
        case 45u: { v = vec3<u32>(0xaafe20d6u, 0x27759f01u, 0xa3152877u); }
        case 46u: { v = vec3<u32>(0xaaf99657u, 0x279b8faeu, 0xa5ba27afu); }
        case 47u: { v = vec3<u32>(0xaaada234u, 0x27671dfdu, 0xa78025eau); }
        case 48u: { v = vec3<u32>(0xaa20a598u, 0x26db220cu, 0xa8602381u); }
        case 49u: { v = vec3<u32>(0xa959a7c7u, 0x25fe2463u, 0xa8b21d65u); }
        case 50u: { v = vec3<u32>(0xa862a8c9u, 0x24de2586u, 0xa8b19c84u); }
        case 51u: { v = vec3<u32>(0xa68da975u, 0x230e2661u, 0xa85ea305u); }
        case 52u: { v = vec3<u32>(0xa428a9e2u, 0x201726ebu, 0xa77fa5a1u); }
        case 53u: { v = vec3<u32>(0x9ec1aa0eu, 0x17eb271fu, 0xa5c1a758u); }
        case 54u: { v = vec3<u32>(0x1a04a9fau, 0x9c3126fbu, 0xa347a845u); }
        case 55u: { v = vec3<u32>(0x2220a9a9u, 0xa1042682u, 0x9d30a892u); }
        case 56u: { v = vec3<u32>(0x2527a920u, 0xa3a225bcu, 0x1c6ea88fu); }
        case 57u: { v = vec3<u32>(0x26f2a868u, 0xa4e924b4u, 0x22d1a83cu); }
        case 58u: { v = vec3<u32>(0x2830a713u, 0xa5bd22f0u, 0x2573a742u); }
        case 59u: { v = vec3<u32>(0x28b3a521u, 0xa6442033u, 0x2719a591u); }
        case 60u: { v = vec3<u32>(0x28fea221u, 0xa67a1956u, 0x281fa30bu); }
        case 61u: { v = vec3<u32>(0x29129bcfu, 0xa65d9a0fu, 0x28679d0eu); }
        case 62u: { v = vec3<u32>(0x28f01c32u, 0xa5f2a034u, 0x28631c30u); }
        case 63u: { v = vec3<u32>(0x289c21dbu, 0xa53fa29bu, 0x28122281u); }
        default: {}
      }
    }
    case 5u: {
      switch (elem_idx & 63u) {
        case 0u: { v = vec3<u32>(0x281c2497u, 0xa451a44du, 0x26fa2534u); }
        case 1u: { v = vec3<u32>(0x26ef25f9u, 0xa267a50eu, 0x255a26c6u); }
        case 2u: { v = vec3<u32>(0x25712708u, 0x9fdfa588u, 0x22cb27dcu); }
        case 3u: { v = vec3<u32>(0x23a027bfu, 0x9975a5b7u, 0x1cf82833u); }
        case 4u: { v = vec3<u32>(0x203f280du, 0x18b6a59cu, 0x9ba7282eu); }
        case 5u: { v = vec3<u32>(0x1736280eu, 0x1f20a53bu, 0xa21b27c3u); }
        case 6u: { v = vec3<u32>(0x9c8b27c8u, 0x21aca49au, 0xa4e726a6u); }
        case 7u: { v = vec3<u32>(0xa126272au, 0x2369a38bu, 0xa664251cu); }
        case 8u: { v = vec3<u32>(0xa3a0264bu, 0x245aa193u, 0xa76b2285u); }
        case 9u: { v = vec3<u32>(0xa4d0253bu, 0x24c09ed4u, 0xa7ed1ce7u); }
        case 10u: { v = vec3<u32>(0xa58d2409u, 0x24e498b6u, 0xa7e49ac8u); }
        case 11u: { v = vec3<u32>(0xa6032186u, 0x24c7180du, 0xa754a1a4u); }
        case 12u: { v = vec3<u32>(0xa6331de5u, 0x246d1e17u, 0xa649a490u); }
        case 13u: { v = vec3<u32>(0xa6211336u, 0x23bd20d3u, 0xa4d8a5f5u); }
        case 14u: { v = vec3<u32>(0xa5d39b78u, 0x22492243u, 0xa238a6edu); }
        case 15u: { v = vec3<u32>(0xa5519fdau, 0x2096234fu, 0x9cd6a767u); }
        case 16u: { v = vec3<u32>(0xa4a5a1a9u, 0x1d7e23ecu, 0x19d3a760u); }
        case 17u: { v = vec3<u32>(0xa3b4a308u, 0x16ed240cu, 0x2124a6dbu); }
        case 18u: { v = vec3<u32>(0xa1f6a402u, 0x979e23d7u, 0x2431a5e4u); }
        case 19u: { v = vec3<u32>(0xa028a44eu, 0x9d3b2332u, 0x257fa48eu); }
        case 20u: { v = vec3<u32>(0x9cb9a46bu, 0xa00b2237u, 0x2666a1e5u); }
        case 21u: { v = vec3<u32>(0x9532a45bu, 0xa12c20f9u, 0x26d99cc0u); }
        case 22u: { v = vec3<u32>(0x175da426u, 0xa1f71f19u, 0x26d418d6u); }
        case 23u: { v = vec3<u32>(0x1c9ba39fu, 0xa2641c10u, 0x265b209du); }
        case 24u: { v = vec3<u32>(0x1ef0a2c2u, 0xa274140bu, 0x2578239eu); }
        case 25u: { v = vec3<u32>(0x2066a1c1u, 0xa22c978du, 0x243f2503u); }
        case 26u: { v = vec3<u32>(0x2117a0aau, 0xa1969c7du, 0x218d25d9u); }
        case 27u: { v = vec3<u32>(0x218c9f17u, 0xa0be9eabu, 0x1ca52645u); }
        case 28u: { v = vec3<u32>(0x21c99cdfu, 0x9f6aa02bu, 0x97b22643u); }
        case 29u: { v = vec3<u32>(0x21d5997bu, 0x9d19a0b7u, 0xa01525d6u); }
        case 30u: { v = vec3<u32>(0x21b59213u, 0x995ca0f9u, 0xa2d6250au); }
        case 31u: { v = vec3<u32>(0x21721426u, 0x8cdba0f0u, 0xa48623dbu); }
        case 32u: { v = vec3<u32>(0x21131941u, 0x179ea0a4u, 0xa54b2130u); }
        case 33u: { v = vec3<u32>(0x209f1c00u, 0x1baba01du, 0xa5af1c84u); }
        case 34u: { v = vec3<u32>(0x201b1d29u, 0x1d659eceu, 0xa5b095c7u); }
        case 35u: { v = vec3<u32>(0x1f1a1e1du, 0x1e889d20u, 0xa5509f1cu); }
        case 36u: { v = vec3<u32>(0x1df01ee1u, 0x1f359a9au, 0xa499a20eu); }
        case 37u: { v = vec3<u32>(0x1cbe1f78u, 0x1f6d95cdu, 0xa336a409u); }
        case 38u: { v = vec3<u32>(0x1b111fe6u, 0x1f340d24u, 0xa0d0a4bdu); }
        case 39u: { v = vec3<u32>(0x18a12017u, 0x1e9917acu, 0x9c5fa51au); }
        case 40u: { v = vec3<u32>(0x14612028u, 0x1daa1a85u, 0x13e3a51eu); }
        case 41u: { v = vec3<u32>(0x87e72027u, 0x1c7e1c4bu, 0x1e14a4cbu); }
        case 42u: { v = vec3<u32>(0x95562014u, 0x1a561cfbu, 0x214ba42au); }
        case 43u: { v = vec3<u32>(0x990e1fdbu, 0x171f1d50u, 0x231ca291u); }
        case 44u: { v = vec3<u32>(0x9b621f66u, 0x0eb71d4cu, 0x2431a071u); }
        case 45u: { v = vec3<u32>(0x9cce1ec6u, 0x92af1cf7u, 0x24889c37u); }
        case 46u: { v = vec3<u32>(0x9dd91dfbu, 0x97ad1c5du, 0x248f1066u); }
        case 47u: { v = vec3<u32>(0x9ec91d05u, 0x998f1b1cu, 0x24481d16u); }
        case 48u: { v = vec3<u32>(0x9f961bcau, 0x9ac41935u, 0x237a208du); }
        case 49u: { v = vec3<u32>(0xa01c193du, 0x9b6e1653u, 0x21f0222eu); }
        case 50u: { v = vec3<u32>(0xa05314e0u, 0x9b8d1078u, 0x20142355u); }
        case 51u: { v = vec3<u32>(0xa06b8c65u, 0x9b2d8e69u, 0x1c0e23f5u); }
        case 52u: { v = vec3<u32>(0xa0629748u, 0x9a5e94f7u, 0x88512404u); }
        case 53u: { v = vec3<u32>(0xa0369abdu, 0x993697adu, 0x9c222395u); }
        case 54u: { v = vec3<u32>(0x9fc99cdeu, 0x979e98cfu, 0x9fb022a8u); }
        case 55u: { v = vec3<u32>(0x9edf9e42u, 0x948d995cu, 0xa14a2156u); }
        case 56u: { v = vec3<u32>(0x9db19f7cu, 0x8dbe997eu, 0xa2541f75u); }
        case 57u: { v = vec3<u32>(0x9c46a03fu, 0x0e11993au, 0xa2e81bceu); }
        case 58u: { v = vec3<u32>(0x9955a09du, 0x1420989cu, 0xa3020c2au); }
        case 59u: { v = vec3<u32>(0x9359a0d4u, 0x163d976bu, 0xa2a79a75u); }
        case 60u: { v = vec3<u32>(0x1343a0e0u, 0x17c09535u, 0xa1e19e57u); }
        case 61u: { v = vec3<u32>(0x197ca0beu, 0x184d9182u, 0xa0c4a073u); }
        case 62u: { v = vec3<u32>(0x1c84a06eu, 0x186383e8u, 0x9ecda160u); }
        case 63u: { v = vec3<u32>(0x1e289fe6u, 0x1825104fu, 0x9b87a1e9u); }
        default: {}
      }
    }
    case 6u: {
      switch (elem_idx & 63u) {
        case 0u: { v = vec3<u32>(0x1f989ea0u, 0x1738144au, 0x9119a20au); }
        case 1u: { v = vec3<u32>(0x20629d15u, 0x15aa1607u, 0x18bea1c6u); }
        case 2u: { v = vec3<u32>(0x20d09aa7u, 0x13801747u, 0x1d13a127u); }
        case 3u: { v = vec3<u32>(0x211095b0u, 0x0e7317f9u, 0x1f50a03cu); }
        case 4u: { v = vec3<u32>(0x211f1071u, 0x88cd180bu, 0x207b9e31u); }
        case 5u: { v = vec3<u32>(0x20fd190fu, 0x917b17a3u, 0x20fb9b48u); }
        case 6u: { v = vec3<u32>(0x20a91c6bu, 0x94ad16aau, 0x212393fau); }
        case 7u: { v = vec3<u32>(0x20271e27u, 0x964a153eu, 0x20f51642u); }
        case 8u: { v = vec3<u32>(0x1ef71fa7u, 0x977c12f2u, 0x207a1bc6u); }
        case 9u: { v = vec3<u32>(0x1d5a206fu, 0x98190ddfu, 0x1f7d1dd5u); }
        case 10u: { v = vec3<u32>(0x1b1020dfu, 0x98328929u, 0x1da21f4eu); }
        case 11u: { v = vec3<u32>(0x1648211fu, 0x9807917au, 0x1b12201eu); }
        case 12u: { v = vec3<u32>(0x8f3a212du, 0x973a94b0u, 0x155a204du); }
        case 13u: { v = vec3<u32>(0x98e92107u, 0x95f29662u, 0x92802035u); }
        case 14u: { v = vec3<u32>(0x9c5d20b0u, 0x944b97b9u, 0x99921fb7u); }
        case 15u: { v = vec3<u32>(0x9e19202bu, 0x90bb9851u, 0x9c781e97u); }
        case 16u: { v = vec3<u32>(0x9f981efbu, 0x84469888u, 0x9dc61d20u); }
        case 17u: { v = vec3<u32>(0xa0651d5bu, 0x0f89987fu, 0x9ea61ae3u); }
        case 18u: { v = vec3<u32>(0xa0d31b10u, 0x13f19836u, 0x9f1216a0u); }
        case 19u: { v = vec3<u32>(0xa1111650u, 0x15e19761u, 0x9f098787u); }
        case 20u: { v = vec3<u32>(0xa11c8ed8u, 0x178195eau, 0x9e959717u); }
        case 21u: { v = vec3<u32>(0xa0f598d1u, 0x1862941bu, 0x9dc59a6eu); }
        case 22u: { v = vec3<u32>(0xa09e9c49u, 0x18ca9015u, 0x9cab9c60u); }
        case 23u: { v = vec3<u32>(0xa0199dfeu, 0x18f502b4u, 0x9aba9d34u); }
        case 24u: { v = vec3<u32>(0x9ed99f75u, 0x18df10d4u, 0x97cc9dacu); }
        case 25u: { v = vec3<u32>(0x9d3ea050u, 0x18881495u, 0x90209dc8u); }
        case 26u: { v = vec3<u32>(0x9ae4a0bbu, 0x17e8168eu, 0x12d19d8eu); }
        case 27u: { v = vec3<u32>(0x9618a0f6u, 0x1654181eu, 0x18299d07u); }
        case 28u: { v = vec3<u32>(0x0f27a100u, 0x146618c5u, 0x1a379c40u); }
        case 29u: { v = vec3<u32>(0x18c8a0d8u, 0x106c1931u, 0x1bc99a94u); }
        case 30u: { v = vec3<u32>(0x1c3ba081u, 0x8216195du, 0x1c69986bu); }
        case 31u: { v = vec3<u32>(0x1de69ffau, 0x91051945u, 0x1ca79455u); }
        case 32u: { v = vec3<u32>(0x1f539ea4u, 0x94cf18eau, 0x1ca001beu); }
        case 33u: { v = vec3<u32>(0x203b9d0eu, 0x96e9184fu, 0x1c5a143fu); }
        case 34u: { v = vec3<u32>(0x20a19a91u, 0x985b16f5u, 0x1bbc17e3u); }
        case 35u: { v = vec3<u32>(0x20d9958fu, 0x990e14edu, 0x1a6c1970u); }
        case 36u: { v = vec3<u32>(0x20df105fu, 0x9985113cu, 0x18de1a8eu); }
        case 37u: { v = vec3<u32>(0x20b518e7u, 0x99b80246u, 0x16511b45u); }
        case 38u: { v = vec3<u32>(0x205c1c3fu, 0x99a390c3u, 0x11981b92u); }
        case 39u: { v = vec3<u32>(0x1fad1ddeu, 0x994894d3u, 0x89381b7bu); }
        case 40u: { v = vec3<u32>(0x1e571f3eu, 0x98a99711u, 0x93bd1b06u); }
        case 41u: { v = vec3<u32>(0x1cc3202au, 0x9799987fu, 0x96b71a41u); }
        case 42u: { v = vec3<u32>(0x1a012089u, 0x957b9941u, 0x988b193au); }
        case 43u: { v = vec3<u32>(0x148b20b9u, 0x922199c2u, 0x99751801u); }
        case 44u: { v = vec3<u32>(0x921a20b9u, 0x878699fdu, 0x9a11154cu); }
        case 45u: { v = vec3<u32>(0x993c2088u, 0x105b99edu, 0x9a5e10eeu); }
        case 46u: { v = vec3<u32>(0x9c5a2029u, 0x14bf9991u, 0x9a5d85e7u); }
        case 47u: { v = vec3<u32>(0x9de51f40u, 0x171a98eeu, 0x9a109229u); }
        case 48u: { v = vec3<u32>(0x9f301de5u, 0x1890980cu, 0x997f958fu); }
        case 49u: { v = vec3<u32>(0xa0171c51u, 0x195c95e8u, 0x98b297b6u); }
        case 50u: { v = vec3<u32>(0xa06a1927u, 0x19e592d5u, 0x976598bau); }
        case 51u: { v = vec3<u32>(0xa08e11ffu, 0x1a2489e8u, 0x951b995du); }
        case 52u: { v = vec3<u32>(0xa083945au, 0x1a150ff4u, 0x913c99bdu); }
        case 53u: { v = vec3<u32>(0xa04899b8u, 0x19b814a0u, 0x80b199d8u); }
        case 54u: { v = vec3<u32>(0x9fc39c7eu, 0x1912170au, 0x110499acu); }
        case 55u: { v = vec3<u32>(0x9ea79debu, 0x182b188eu, 0x14ec993cu); }
        case 56u: { v = vec3<u32>(0x9d499f15u, 0x161e195du, 0x1717988cu); }
        case 57u: { v = vec3<u32>(0x9b729ff1u, 0x132f19e7u, 0x18759747u); }
        case 58u: { v = vec3<u32>(0x980fa03bu, 0x0b1c1a25u, 0x1927951au); }
        case 59u: { v = vec3<u32>(0x8c76a04fu, 0x8f681a14u, 0x19989153u); }
        case 60u: { v = vec3<u32>(0x15cfa036u, 0x947d19b5u, 0x19c18131u); }
        case 61u: { v = vec3<u32>(0x1a2f9fe1u, 0x96e4190du, 0x199f1113u); }
        case 62u: { v = vec3<u32>(0x1c939f06u, 0x98771825u, 0x1932150au); }
        case 63u: { v = vec3<u32>(0x1dd69de5u, 0x99401613u, 0x187f174eu); }
        default: {}
      }
    }
    case 7u: {
      switch (elem_idx & 63u) {
        case 0u: { v = vec3<u32>(0x1ed59c8cu, 0x99c51323u, 0x1717189au); }
        case 1u: { v = vec3<u32>(0x1f869a13u, 0x99fd0b41u, 0x14ca1951u); }
        case 2u: { v = vec3<u32>(0x1fe495c2u, 0x99e78f17u, 0x106319c0u); }
        case 3u: { v = vec3<u32>(0x1fec09cbu, 0x99869455u, 0x886e19deu); }
        case 4u: { v = vec3<u32>(0x1fa01703u, 0x98de96a3u, 0x929d19a9u); }
        case 5u: { v = vec3<u32>(0x1f051a6du, 0x97f2984au, 0x95e81922u); }
        case 6u: { v = vec3<u32>(0x1e251c80u, 0x95c89907u, 0x981a184eu); }
        case 7u: { v = vec3<u32>(0x1d0a1d91u, 0x92b8997fu, 0x9907166fu); }
        case 8u: { v = vec3<u32>(0x1b841e5fu, 0x8a7999aeu, 0x99ac13b8u); }
        case 9u: { v = vec3<u32>(0x18ba1ee4u, 0x0ef19992u, 0x99fd0c1eu); }
        case 10u: { v = vec3<u32>(0x13541f1cu, 0x1424992eu, 0x99f48f92u); }
        case 11u: { v = vec3<u32>(0x902c1f09u, 0x16499889u, 0x999194bbu); }
        case 12u: { v = vec3<u32>(0x978e1eacu, 0x18089757u, 0x98d69750u); }
        case 13u: { v = vec3<u32>(0x9a431e0du, 0x18b29548u, 0x979f98bcu); }
        case 14u: { v = vec3<u32>(0x9c331d35u, 0x191a9201u, 0x95159989u); }
        case 15u: { v = vec3<u32>(0x9d101c30u, 0x193d8905u, 0x906e9a00u); }
        case 16u: { v = vec3<u32>(0x9daf1a12u, 0x191a0edeu, 0x0a769a18u); }
        case 17u: { v = vec3<u32>(0x9e0d173bu, 0x18b613d1u, 0x139899d0u); }
        case 18u: { v = vec3<u32>(0x9e2a1079u, 0x181715d6u, 0x16909929u); }
        case 19u: { v = vec3<u32>(0x9e069145u, 0x168d1769u, 0x1876982fu); }
        case 20u: { v = vec3<u32>(0x9da7972fu, 0x14a41847u, 0x195d95e1u); }
        case 21u: { v = vec3<u32>(0x9d1399a0u, 0x111a189du, 0x19ec9205u); }
        case 22u: { v = vec3<u32>(0x9c539b57u, 0x066618b3u, 0x1a1a00e7u); }
        case 23u: { v = vec3<u32>(0x9ae29c58u, 0x8ecb188bu, 0x19e4123du); }
        case 24u: { v = vec3<u32>(0x98ef9cd1u, 0x93461828u, 0x194c15fau); }
        case 25u: { v = vec3<u32>(0x95ca9d14u, 0x95521725u, 0x185c1839u); }
        case 26u: { v = vec3<u32>(0x8ecc9d22u, 0x96ab15a7u, 0x1646192du); }
        case 27u: { v = vec3<u32>(0x107b9cfeu, 0x979f13d8u, 0x12da19c9u); }
        case 28u: { v = vec3<u32>(0x15e29cabu, 0x9813101du, 0x05ca1a02u); }
        case 29u: { v = vec3<u32>(0x188d9c30u, 0x981d0287u, 0x916c19d5u); }
        case 30u: { v = vec3<u32>(0x19e79b29u, 0x97e38eb1u, 0x95961944u); }
        case 31u: { v = vec3<u32>(0x1af699c0u, 0x972692b0u, 0x9809185au); }
        case 32u: { v = vec3<u32>(0x1bb59837u, 0x961394c6u, 0x98fe164cu); }
        case 33u: { v = vec3<u32>(0x1c10953eu, 0x94bb95e5u, 0x999c12f8u); }
        case 34u: { v = vec3<u32>(0x1c1e901fu, 0x926596abu, 0x99d6074eu); }
        case 35u: { v = vec3<u32>(0x1c060c00u, 0x8e43970fu, 0x99a99127u); }
        case 36u: { v = vec3<u32>(0x1b9913acu, 0x013e9712u, 0x99199567u); }
        case 37u: { v = vec3<u32>(0x1aea165du, 0x0e9596b7u, 0x983097d4u); }
        case 38u: { v = vec3<u32>(0x1a0a1842u, 0x121f9607u, 0x95ff98d8u); }
        case 39u: { v = vec3<u32>(0x1906191fu, 0x1441950eu, 0x9270996cu); }
        case 40u: { v = vec3<u32>(0x17d119c4u, 0x152d93bau, 0x83fb999eu); }
        case 41u: { v = vec3<u32>(0x157b1a2fu, 0x15ca910cu, 0x116a9969u); }
        case 42u: { v = vec3<u32>(0x12411a61u, 0x16138c70u, 0x156f98d3u); }
        case 43u: { v = vec3<u32>(0x0a9d1a5eu, 0x160804d6u, 0x17bf97ceu); }
        case 44u: { v = vec3<u32>(0x8d661a2au, 0x15ad0e8eu, 0x18bd956cu); }
        case 45u: { v = vec3<u32>(0x92b119cau, 0x150b11abu, 0x1940915bu); }
        case 46u: { v = vec3<u32>(0x951f1946u, 0x142b13aau, 0x196103a6u); }
        case 47u: { v = vec3<u32>(0x96a318a3u, 0x123a1498u, 0x191d122au); }
        case 48u: { v = vec3<u32>(0x97e117d5u, 0x0fbe1515u, 0x187b15aeu); }
        case 49u: { v = vec3<u32>(0x986b1643u, 0x099c154au, 0x170c17d4u); }
        case 50u: { v = vec3<u32>(0x98c0149eu, 0x88361536u, 0x14a418b1u); }
        case 51u: { v = vec3<u32>(0x98f211e5u, 0x8ebc14ddu, 0x0fa7191cu); }
        case 52u: { v = vec3<u32>(0x99010d2bu, 0x916e1446u, 0x8b6a1926u); }
        case 53u: { v = vec3<u32>(0x98f184f4u, 0x932612f3u, 0x935718cdu); }
        case 54u: { v = vec3<u32>(0x98c38f50u, 0x94381109u, 0x961d1819u); }
        case 55u: { v = vec3<u32>(0x987b9279u, 0x94a10dd0u, 0x980a162fu); }
        case 56u: { v = vec3<u32>(0x981c9484u, 0x94c80566u, 0x98b61371u); }
        case 57u: { v = vec3<u32>(0x975295a6u, 0x94ae8a2fu, 0x99050bf8u); }
        case 58u: { v = vec3<u32>(0x964b96a0u, 0x94568f4au, 0x98f38f28u); }
        case 59u: { v = vec3<u32>(0x9529976eu, 0x93889184u, 0x9880946cu); }
        case 60u: { v = vec3<u32>(0x93e29808u, 0x92029313u, 0x976c96b6u); }
        case 61u: { v = vec3<u32>(0x91529842u, 0x902e941fu, 0x9549983du); }
        case 62u: { v = vec3<u32>(0x8d5d9866u, 0x8c4a947cu, 0x917e98ccu); }
        case 63u: { v = vec3<u32>(0x00009871u, 0x0000949bu, 0x000098fdu); }
        default: {}
      }
    }
    default: {}
  }
  return v;
}

fn bsdf_mf_lut_ior_s_u32(word_idx: u32) -> u32 {
  let vec_idx = word_idx >> 2u;
  let lane = word_idx & 3u;
  var v = vec4<u32>(0u);
  switch (vec_idx >> 6u) {
    case 0u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x000003ffu, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 3u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 5u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 7u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 9u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 11u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 13u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 14u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 15u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 17u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 19u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 21u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 23u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 25u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 27u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 29u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 1u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x6091cfffu, 0x121b293eu, 0x0406090cu, 0x02020303u); }
        case 1u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x6194d0efu, 0x121b293fu, 0x0406090cu, 0x02020303u); }
        case 3u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x608ebbc5u, 0x121a283eu, 0x0406080cu, 0x02020203u); }
        case 5u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x55768c8fu, 0x11192639u, 0x0406080bu, 0x01020203u); }
        case 7u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x42535b5cu, 0x0f16202fu, 0x0405070au, 0x01020203u); }
        case 9u: { v = vec4<u32>(0x01010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x2c323535u, 0x0c111922u, 0x03050609u, 0x01010203u); }
        case 11u: { v = vec4<u32>(0x01010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x191b1c1cu, 0x090c1115u, 0x03040507u, 0x01010202u); }
        case 13u: { v = vec4<u32>(0x00010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 14u: { v = vec4<u32>(0x0d0e0e0eu, 0x06080a0cu, 0x02030405u, 0x01010102u); }
        case 15u: { v = vec4<u32>(0x00000101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x07070707u, 0x04050607u, 0x02020303u, 0x01010101u); }
        case 17u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x03030303u, 0x02030303u, 0x01010202u, 0x00010101u); }
        case 19u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x02020202u, 0x01020202u, 0x01010101u, 0x00000001u); }
        case 21u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00010101u, 0x00000000u); }
        case 23u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 25u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 27u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 29u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 2u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x8ab4e2ffu, 0x29384c67u, 0x0d11171fu, 0x0506080au); }
        case 1u: { v = vec4<u32>(0x02030404u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 2u: { v = vec4<u32>(0x8cb8e1f7u, 0x29384d68u, 0x0d11171fu, 0x0506080au); }
        case 3u: { v = vec4<u32>(0x02030404u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 4u: { v = vec4<u32>(0x8db5d8e0u, 0x2a394d69u, 0x0d11171fu, 0x0506080au); }
        case 5u: { v = vec4<u32>(0x02030304u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 6u: { v = vec4<u32>(0x86a7bcbfu, 0x29384c66u, 0x0d11171eu, 0x0506080au); }
        case 7u: { v = vec4<u32>(0x02030304u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 8u: { v = vec4<u32>(0x778d9798u, 0x2735475eu, 0x0d11161du, 0x0506080au); }
        case 9u: { v = vec4<u32>(0x02030304u, 0x01010202u, 0x01010101u, 0x01010101u); }
        case 10u: { v = vec4<u32>(0x616d7272u, 0x242f3e50u, 0x0c0f141bu, 0x05060709u); }
        case 11u: { v = vec4<u32>(0x02030304u, 0x01010202u, 0x01010101u, 0x01010101u); }
        case 12u: { v = vec4<u32>(0x494f5051u, 0x1f28333fu, 0x0b0e1218u, 0x04050708u); }
        case 13u: { v = vec4<u32>(0x02020304u, 0x01010102u, 0x01010101u, 0x00010101u); }
        case 14u: { v = vec4<u32>(0x33353636u, 0x1920272eu, 0x090c0f14u, 0x04050607u); }
        case 15u: { v = vec4<u32>(0x02020303u, 0x01010102u, 0x01010101u, 0x00000001u); }
        case 16u: { v = vec4<u32>(0x22222323u, 0x13181c1fu, 0x080a0c10u, 0x03040506u); }
        case 17u: { v = vec4<u32>(0x02020203u, 0x01010101u, 0x01010101u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x15151616u, 0x0e111314u, 0x06080a0cu, 0x03030405u); }
        case 19u: { v = vec4<u32>(0x01020202u, 0x01010101u, 0x00010101u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x0d0d0d0du, 0x0a0b0c0du, 0x05060709u, 0x02030304u); }
        case 21u: { v = vec4<u32>(0x01010202u, 0x01010101u, 0x00000001u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x08080808u, 0x07070808u, 0x04040506u, 0x02020303u); }
        case 23u: { v = vec4<u32>(0x01010102u, 0x01010101u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x05050505u, 0x04050505u, 0x03030404u, 0x01020202u); }
        case 25u: { v = vec4<u32>(0x01010101u, 0x00000101u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x02020203u, 0x01010102u); }
        case 27u: { v = vec4<u32>(0x01010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01010202u, 0x01010101u); }
        case 29u: { v = vec4<u32>(0x00010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00000101u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 3u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xa0c5e9ffu, 0x3d4e647fu, 0x171d2530u, 0x0a0c0f13u); }
        case 1u: { v = vec4<u32>(0x05060708u, 0x03030404u, 0x02020203u, 0x01020202u); }
        case 2u: { v = vec4<u32>(0xa2c8e7fau, 0x3d4f6581u, 0x171d2530u, 0x0a0c0f13u); }
        case 3u: { v = vec4<u32>(0x05060708u, 0x03030404u, 0x02020203u, 0x01020202u); }
        case 4u: { v = vec4<u32>(0xa4c6e3eau, 0x3e4f6683u, 0x171d2530u, 0x0a0c0f13u); }
        case 5u: { v = vec4<u32>(0x05060708u, 0x03030404u, 0x02020203u, 0x01010202u); }
        case 6u: { v = vec4<u32>(0x9fbdcfd2u, 0x3d4f6681u, 0x171d2530u, 0x0a0c0f12u); }
        case 7u: { v = vec4<u32>(0x05060708u, 0x03030404u, 0x02020203u, 0x01010202u); }
        case 8u: { v = vec4<u32>(0x94aab3b4u, 0x3c4d627au, 0x171d242fu, 0x0a0c0f12u); }
        case 9u: { v = vec4<u32>(0x05060708u, 0x03030404u, 0x02020202u, 0x01010102u); }
        case 10u: { v = vec4<u32>(0x828f9494u, 0x39485a6eu, 0x161c232du, 0x090b0e11u); }
        case 11u: { v = vec4<u32>(0x05050608u, 0x03030304u, 0x02020202u, 0x01010102u); }
        case 12u: { v = vec4<u32>(0x6b737575u, 0x34414f5eu, 0x151a2029u, 0x090b0d10u); }
        case 13u: { v = vec4<u32>(0x04050607u, 0x02030304u, 0x02020202u, 0x01010101u); }
        case 14u: { v = vec4<u32>(0x54585959u, 0x2d37424cu, 0x13171d24u, 0x080a0c0fu); }
        case 15u: { v = vec4<u32>(0x04050607u, 0x02030304u, 0x01020202u, 0x01010101u); }
        case 16u: { v = vec4<u32>(0x3f404141u, 0x262d343bu, 0x1115191fu, 0x07090b0eu); }
        case 17u: { v = vec4<u32>(0x04040506u, 0x02020303u, 0x01010202u, 0x01010101u); }
        case 18u: { v = vec4<u32>(0x2d2e2e2eu, 0x1e23282bu, 0x0e111519u, 0x07080a0cu); }
        case 19u: { v = vec4<u32>(0x03040506u, 0x02020303u, 0x01010102u, 0x01010101u); }
        case 20u: { v = vec4<u32>(0x1f202020u, 0x171a1d1eu, 0x0c0e1114u, 0x0607080au); }
        case 21u: { v = vec4<u32>(0x03030405u, 0x02020203u, 0x01010101u, 0x01010101u); }
        case 22u: { v = vec4<u32>(0x15151515u, 0x11131415u, 0x0a0b0d0fu, 0x05060708u); }
        case 23u: { v = vec4<u32>(0x03030304u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 24u: { v = vec4<u32>(0x0e0e0e0eu, 0x0c0d0e0eu, 0x08090a0bu, 0x04050506u); }
        case 25u: { v = vec4<u32>(0x02020303u, 0x01010202u, 0x01010101u, 0x00010101u); }
        case 26u: { v = vec4<u32>(0x09090909u, 0x08090909u, 0x06060708u, 0x03040405u); }
        case 27u: { v = vec4<u32>(0x02020203u, 0x01010102u, 0x01010101u, 0x00000101u); }
        case 28u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x04050506u, 0x03030304u); }
        case 29u: { v = vec4<u32>(0x01020202u, 0x01010101u, 0x01010101u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x03030404u, 0x02020203u); }
        case 31u: { v = vec4<u32>(0x01010102u, 0x01010101u, 0x00000101u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x02020202u, 0x03030302u, 0x02020203u, 0x01020202u); }
        case 33u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x01010101u); }
        case 35u: { v = vec4<u32>(0x01010101u, 0x00000101u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 37u: { v = vec4<u32>(0x01010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 39u: { v = vec4<u32>(0x00000001u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 4u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xaecfedffu, 0x4d5f7590u, 0x2128323eu, 0x0f12161bu); }
        case 1u: { v = vec4<u32>(0x08090b0du, 0x05050607u, 0x03040404u, 0x02030303u); }
        case 2u: { v = vec4<u32>(0xb0d1ebfbu, 0x4d607691u, 0x2128323eu, 0x0f12161bu); }
        case 3u: { v = vec4<u32>(0x08090b0du, 0x05050607u, 0x03040404u, 0x02030303u); }
        case 4u: { v = vec4<u32>(0xb2d0e9efu, 0x4e617893u, 0x2129323eu, 0x0f12161bu); }
        case 5u: { v = vec4<u32>(0x08090b0du, 0x05050607u, 0x03030404u, 0x02030303u); }
        case 6u: { v = vec4<u32>(0xafc9dadcu, 0x4e617893u, 0x2128323eu, 0x0f12161bu); }
        case 7u: { v = vec4<u32>(0x08090b0du, 0x05050607u, 0x03030404u, 0x02020303u); }
        case 8u: { v = vec4<u32>(0xa6bac3c4u, 0x4d5f758du, 0x2028323eu, 0x0f12161au); }
        case 9u: { v = vec4<u32>(0x08090b0cu, 0x05050607u, 0x03030404u, 0x02020303u); }
        case 10u: { v = vec4<u32>(0x97a4a9a9u, 0x4a5b6e83u, 0x2027303cu, 0x0f11151au); }
        case 11u: { v = vec4<u32>(0x08090a0cu, 0x04050607u, 0x03030404u, 0x02020203u); }
        case 12u: { v = vec4<u32>(0x838b8d8du, 0x45546475u, 0x1e252e38u, 0x0e111419u); }
        case 13u: { v = vec4<u32>(0x07080a0cu, 0x04050506u, 0x03030304u, 0x02020203u); }
        case 14u: { v = vec4<u32>(0x6c717273u, 0x3f4b5864u, 0x1c232a34u, 0x0d101317u); }
        case 15u: { v = vec4<u32>(0x0708090bu, 0x04050506u, 0x03030304u, 0x02020202u); }
        case 16u: { v = vec4<u32>(0x57595a5au, 0x37404a51u, 0x1a1f262eu, 0x0c0f1215u); }
        case 17u: { v = vec4<u32>(0x0608090au, 0x04040506u, 0x02030303u, 0x02020202u); }
        case 18u: { v = vec4<u32>(0x43444545u, 0x2e353b40u, 0x171c2127u, 0x0b0d1013u); }
        case 19u: { v = vec4<u32>(0x0607080au, 0x03040405u, 0x02020303u, 0x02020202u); }
        case 20u: { v = vec4<u32>(0x32333333u, 0x262a2e31u, 0x14181c21u, 0x0a0c0e11u); }
        case 21u: { v = vec4<u32>(0x05060709u, 0x03040405u, 0x02020203u, 0x01010202u); }
        case 22u: { v = vec4<u32>(0x25252525u, 0x1d202324u, 0x1114171au, 0x090a0c0eu); }
        case 23u: { v = vec4<u32>(0x05060608u, 0x03030404u, 0x02020202u, 0x01010102u); }
        case 24u: { v = vec4<u32>(0x1a1a1a1au, 0x1618191au, 0x0e101214u, 0x08090a0cu); }
        case 25u: { v = vec4<u32>(0x04050606u, 0x02030304u, 0x02020202u, 0x01010101u); }
        case 26u: { v = vec4<u32>(0x12121212u, 0x11111212u, 0x0b0d0e0fu, 0x0607080au); }
        case 27u: { v = vec4<u32>(0x04040505u, 0x02020303u, 0x01010202u, 0x01010101u); }
        case 28u: { v = vec4<u32>(0x0d0d0d0du, 0x0c0c0d0du, 0x090a0b0bu, 0x05060708u); }
        case 29u: { v = vec4<u32>(0x03030405u, 0x02020203u, 0x01010102u, 0x01010101u); }
        case 30u: { v = vec4<u32>(0x09090909u, 0x08090909u, 0x07070808u, 0x04050506u); }
        case 31u: { v = vec4<u32>(0x02030304u, 0x02020202u, 0x01010101u, 0x01010101u); }
        case 32u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x05050606u, 0x03040404u); }
        case 33u: { v = vec4<u32>(0x02020303u, 0x01010202u, 0x01010101u, 0x01010101u); }
        case 34u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04040404u, 0x03030303u); }
        case 35u: { v = vec4<u32>(0x02020202u, 0x01010101u, 0x01010101u, 0x00000101u); }
        case 36u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x02020202u); }
        case 37u: { v = vec4<u32>(0x01010202u, 0x01010101u, 0x01010101u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x01020202u); }
        case 39u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00000101u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 41u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 43u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x01010000u, 0x01010101u, 0x01010101u); }
        case 45u: { v = vec4<u32>(0x00000001u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 5u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xb8d5f0ffu, 0x596c829cu, 0x2a323d4au, 0x15181d23u); }
        case 1u: { v = vec4<u32>(0x0b0d0f11u, 0x0708090au, 0x05050606u, 0x04040404u); }
        case 2u: { v = vec4<u32>(0xbad8edfcu, 0x5a6d839du, 0x2a323d4au, 0x15181d23u); }
        case 3u: { v = vec4<u32>(0x0b0d0f11u, 0x0708090au, 0x05050606u, 0x04040404u); }
        case 4u: { v = vec4<u32>(0xbcd6ecf2u, 0x5b6e859fu, 0x2a323d4au, 0x15181d23u); }
        case 5u: { v = vec4<u32>(0x0b0d0f11u, 0x0708090au, 0x05050606u, 0x04040404u); }
        case 6u: { v = vec4<u32>(0xb9d1e0e2u, 0x5b6f869fu, 0x2a333d4bu, 0x14181d23u); }
        case 7u: { v = vec4<u32>(0x0b0d0f11u, 0x0708090au, 0x05050506u, 0x03040404u); }
        case 8u: { v = vec4<u32>(0xb2c5cdceu, 0x5a6e839bu, 0x29323d4au, 0x14181d22u); }
        case 9u: { v = vec4<u32>(0x0b0d0f11u, 0x0707080au, 0x04050506u, 0x03040404u); }
        case 10u: { v = vec4<u32>(0xa5b2b7b7u, 0x586a7e92u, 0x29313c49u, 0x14181c22u); }
        case 11u: { v = vec4<u32>(0x0b0c0e11u, 0x06070809u, 0x04050506u, 0x03030404u); }
        case 12u: { v = vec4<u32>(0x939b9e9eu, 0x54647586u, 0x27303a46u, 0x13171b21u); }
        case 13u: { v = vec4<u32>(0x0a0c0e10u, 0x06070809u, 0x04050506u, 0x03030304u); }
        case 14u: { v = vec4<u32>(0x7f848585u, 0x4d5b6976u, 0x262d3641u, 0x12161a1fu); }
        case 15u: { v = vec4<u32>(0x0a0c0d10u, 0x06070809u, 0x04040505u, 0x03030304u); }
        case 16u: { v = vec4<u32>(0x6a6d6e6eu, 0x45505b64u, 0x232a323bu, 0x1115191du); }
        case 17u: { v = vec4<u32>(0x090b0d0fu, 0x06060708u, 0x04040405u, 0x03030303u); }
        case 18u: { v = vec4<u32>(0x56575858u, 0x3c454c52u, 0x20262d34u, 0x1013171bu); }
        case 19u: { v = vec4<u32>(0x090a0c0eu, 0x05060708u, 0x03040405u, 0x02030303u); }
        case 20u: { v = vec4<u32>(0x44454545u, 0x33393e42u, 0x1c21272du, 0x0f111418u); }
        case 21u: { v = vec4<u32>(0x08090b0du, 0x05050607u, 0x03030404u, 0x02020303u); }
        case 22u: { v = vec4<u32>(0x34353535u, 0x2a2e3133u, 0x191d2125u, 0x0d0f1215u); }
        case 23u: { v = vec4<u32>(0x07080a0bu, 0x04050606u, 0x03030304u, 0x02020203u); }
        case 24u: { v = vec4<u32>(0x27282828u, 0x21242627u, 0x15181b1eu, 0x0c0e1012u); }
        case 25u: { v = vec4<u32>(0x0708090au, 0x04040506u, 0x03030304u, 0x02020202u); }
        case 26u: { v = vec4<u32>(0x1d1d1d1du, 0x1a1b1c1du, 0x11141618u, 0x0a0c0d0fu); }
        case 27u: { v = vec4<u32>(0x06070809u, 0x03040405u, 0x02020303u, 0x01020202u); }
        case 28u: { v = vec4<u32>(0x15151515u, 0x13141515u, 0x0e101112u, 0x080a0b0cu); }
        case 29u: { v = vec4<u32>(0x05060707u, 0x03030404u, 0x02020203u, 0x01010202u); }
        case 30u: { v = vec4<u32>(0x0f0f0f0fu, 0x0e0f0f0fu, 0x0b0c0d0eu, 0x0708090au); }
        case 31u: { v = vec4<u32>(0x04050506u, 0x03030304u, 0x02020202u, 0x01010102u); }
        case 32u: { v = vec4<u32>(0x0b0b0b0bu, 0x0a0b0b0bu, 0x09090a0au, 0x06060708u); }
        case 33u: { v = vec4<u32>(0x04040505u, 0x02020303u, 0x01020202u, 0x01010101u); }
        case 34u: { v = vec4<u32>(0x07070707u, 0x07080807u, 0x06070707u, 0x05050606u); }
        case 35u: { v = vec4<u32>(0x03030404u, 0x02020203u, 0x01010102u, 0x01010101u); }
        case 36u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x05050505u, 0x04040405u); }
        case 37u: { v = vec4<u32>(0x02030303u, 0x02020202u, 0x01010101u, 0x01010101u); }
        case 38u: { v = vec4<u32>(0x04040303u, 0x04040404u, 0x03040404u, 0x03030303u); }
        case 39u: { v = vec4<u32>(0x02020203u, 0x01010202u, 0x01010101u, 0x01010101u); }
        case 40u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02030303u, 0x02020202u); }
        case 41u: { v = vec4<u32>(0x01020202u, 0x01010101u, 0x01010101u, 0x00000101u); }
        case 42u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 43u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 45u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00000101u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 47u: { v = vec4<u32>(0x01010101u, 0x00010101u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01010000u, 0x01010101u); }
        case 49u: { v = vec4<u32>(0x00000101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 6u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xbfdaf2ffu, 0x64778ca5u, 0x323b4654u, 0x1a1e232au); }
        case 1u: { v = vec4<u32>(0x0f111316u, 0x090a0b0du, 0x06070708u, 0x05050506u); }
        case 2u: { v = vec4<u32>(0xc1dceefcu, 0x64778da6u, 0x323b4654u, 0x1a1e232au); }
        case 3u: { v = vec4<u32>(0x0e111316u, 0x090a0b0du, 0x06070708u, 0x05050506u); }
        case 4u: { v = vec4<u32>(0xc3daeff4u, 0x65798fa8u, 0x323b4755u, 0x1a1e232au); }
        case 5u: { v = vec4<u32>(0x0e111316u, 0x090a0b0du, 0x06070708u, 0x05050506u); }
        case 6u: { v = vec4<u32>(0xc0d6e5e7u, 0x667990a8u, 0x323b4755u, 0x1a1e232au); }
        case 7u: { v = vec4<u32>(0x0e101316u, 0x090a0b0du, 0x06070708u, 0x05050506u); }
        case 8u: { v = vec4<u32>(0xbaccd4d5u, 0x66798ea4u, 0x323b4755u, 0x191e232au); }
        case 9u: { v = vec4<u32>(0x0e101316u, 0x090a0b0cu, 0x06070708u, 0x05050506u); }
        case 10u: { v = vec4<u32>(0xb0bcc0c1u, 0x6376899du, 0x313b4654u, 0x191d2329u); }
        case 11u: { v = vec4<u32>(0x0e101215u, 0x090a0b0cu, 0x06060708u, 0x04050505u); }
        case 12u: { v = vec4<u32>(0xa0a8aaaau, 0x5f708192u, 0x30394451u, 0x181d2228u); }
        case 13u: { v = vec4<u32>(0x0e101215u, 0x08090b0cu, 0x06060707u, 0x04040505u); }
        case 14u: { v = vec4<u32>(0x8d929394u, 0x59687683u, 0x2e37414cu, 0x181c2127u); }
        case 15u: { v = vec4<u32>(0x0d0f1114u, 0x08090a0bu, 0x05060607u, 0x04040505u); }
        case 16u: { v = vec4<u32>(0x797c7d7du, 0x525e6972u, 0x2b333c47u, 0x171a1f25u); }
        case 17u: { v = vec4<u32>(0x0d0e1113u, 0x08090a0bu, 0x05060607u, 0x04040405u); }
        case 18u: { v = vec4<u32>(0x65676767u, 0x49525b61u, 0x282f3740u, 0x15191d22u); }
        case 19u: { v = vec4<u32>(0x0c0e1012u, 0x0708090au, 0x05050606u, 0x03040404u); }
        case 20u: { v = vec4<u32>(0x53545454u, 0x3f464c50u, 0x242a3138u, 0x14171b1fu); }
        case 21u: { v = vec4<u32>(0x0b0d0f11u, 0x0708090au, 0x04050506u, 0x03030404u); }
        case 22u: { v = vec4<u32>(0x42434343u, 0x353a3e41u, 0x20252a30u, 0x1215181cu); }
        case 23u: { v = vec4<u32>(0x0a0c0d0fu, 0x06070809u, 0x04040506u, 0x03030304u); }
        case 24u: { v = vec4<u32>(0x34343434u, 0x2c2f3133u, 0x1c202428u, 0x10121518u); }
        case 25u: { v = vec4<u32>(0x090b0c0eu, 0x06060708u, 0x04040405u, 0x03030303u); }
        case 26u: { v = vec4<u32>(0x28282828u, 0x23252627u, 0x181b1e21u, 0x0e101215u); }
        case 27u: { v = vec4<u32>(0x08090b0cu, 0x05060607u, 0x03040405u, 0x02020303u); }
        case 28u: { v = vec4<u32>(0x1e1e1e1eu, 0x1b1d1d1eu, 0x1416181au, 0x0c0e1012u); }
        case 29u: { v = vec4<u32>(0x0708090bu, 0x04050606u, 0x03030404u, 0x02020203u); }
        case 30u: { v = vec4<u32>(0x16161616u, 0x15161616u, 0x10111314u, 0x0a0c0d0eu); }
        case 31u: { v = vec4<u32>(0x06070809u, 0x04040506u, 0x03030304u, 0x02020202u); }
        case 32u: { v = vec4<u32>(0x10101010u, 0x10101010u, 0x0d0e0f0fu, 0x090a0b0cu); }
        case 33u: { v = vec4<u32>(0x05060708u, 0x03040405u, 0x02020303u, 0x01020202u); }
        case 34u: { v = vec4<u32>(0x0c0c0c0cu, 0x0c0c0c0cu, 0x0a0a0b0bu, 0x07080809u); }
        case 35u: { v = vec4<u32>(0x05050606u, 0x03030404u, 0x02020203u, 0x01010202u); }
        case 36u: { v = vec4<u32>(0x08080808u, 0x08080808u, 0x08080808u, 0x06060707u); }
        case 37u: { v = vec4<u32>(0x04040505u, 0x02030303u, 0x02020202u, 0x01010101u); }
        case 38u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x06060606u, 0x04050505u); }
        case 39u: { v = vec4<u32>(0x03030404u, 0x02020203u, 0x01010202u, 0x01010101u); }
        case 40u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04040404u, 0x03040404u); }
        case 41u: { v = vec4<u32>(0x02030303u, 0x02020202u, 0x01010102u, 0x01010101u); }
        case 42u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 43u: { v = vec4<u32>(0x02020202u, 0x01010202u, 0x01010101u, 0x01010101u); }
        case 44u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 45u: { v = vec4<u32>(0x01020202u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 46u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 47u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00000001u); }
        case 48u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 49u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00010101u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x01010000u, 0x01010101u, 0x01010101u); }
        case 51u: { v = vec4<u32>(0x01010101u, 0x00010101u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 7u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xc4ddf3ffu, 0x6c7f94acu, 0x39434e5cu, 0x1f232930u); }
        case 1u: { v = vec4<u32>(0x1214171au, 0x0b0d0e10u, 0x0809090au, 0x06070707u); }
        case 2u: { v = vec4<u32>(0xc6dfeffdu, 0x6d8095adu, 0x39434f5du, 0x1f232930u); }
        case 3u: { v = vec4<u32>(0x1214171au, 0x0b0d0e10u, 0x0809090au, 0x06070707u); }
        case 4u: { v = vec4<u32>(0xc8ddf0f5u, 0x6e8197afu, 0x39434f5du, 0x1f232930u); }
        case 5u: { v = vec4<u32>(0x1214171au, 0x0b0c0e10u, 0x0809090au, 0x06060707u); }
        case 6u: { v = vec4<u32>(0xc6dae8eau, 0x6f8298afu, 0x39434f5eu, 0x1e232930u); }
        case 7u: { v = vec4<u32>(0x1214171au, 0x0b0c0e10u, 0x0808090au, 0x06060707u); }
        case 8u: { v = vec4<u32>(0xc1d2d9dau, 0x6f8297acu, 0x39434f5eu, 0x1e232930u); }
        case 9u: { v = vec4<u32>(0x1114171au, 0x0b0c0e0fu, 0x0808090au, 0x06060707u); }
        case 10u: { v = vec4<u32>(0xb7c3c7c8u, 0x6d7f92a5u, 0x38434f5du, 0x1e232930u); }
        case 11u: { v = vec4<u32>(0x1114161au, 0x0b0c0d0fu, 0x0708090au, 0x06060607u); }
        case 12u: { v = vec4<u32>(0xa9b1b3b4u, 0x697a8b9bu, 0x37414d5au, 0x1d22282fu); }
        case 13u: { v = vec4<u32>(0x11131619u, 0x0a0c0d0fu, 0x07080909u, 0x05060607u); }
        case 14u: { v = vec4<u32>(0x989d9e9eu, 0x6472818eu, 0x353f4a56u, 0x1d21272du); }
        case 15u: { v = vec4<u32>(0x10131519u, 0x0a0b0d0eu, 0x07080809u, 0x05050606u); }
        case 16u: { v = vec4<u32>(0x85888989u, 0x5c69747eu, 0x333b4550u, 0x1b20252bu); }
        case 17u: { v = vec4<u32>(0x10121518u, 0x0a0b0c0eu, 0x07070809u, 0x05050606u); }
        case 18u: { v = vec4<u32>(0x71737474u, 0x535d666du, 0x30374049u, 0x1a1e2329u); }
        case 19u: { v = vec4<u32>(0x0f111316u, 0x090a0c0du, 0x06070708u, 0x04050506u); }
        case 20u: { v = vec4<u32>(0x5f606161u, 0x4a51585cu, 0x2c323a42u, 0x181c2126u); }
        case 21u: { v = vec4<u32>(0x0e101215u, 0x090a0b0cu, 0x06060708u, 0x04040505u); }
        case 22u: { v = vec4<u32>(0x4e4f4f4fu, 0x4045494cu, 0x272d3339u, 0x161a1e22u); }
        case 23u: { v = vec4<u32>(0x0d0f1113u, 0x08090a0bu, 0x05060607u, 0x04040405u); }
        case 24u: { v = vec4<u32>(0x3f3f4040u, 0x35393c3eu, 0x23272c31u, 0x14171b1eu); }
        case 25u: { v = vec4<u32>(0x0c0e0f12u, 0x0708090bu, 0x05050607u, 0x03040404u); }
        case 26u: { v = vec4<u32>(0x32323232u, 0x2c2e3031u, 0x1e222529u, 0x1215171bu); }
        case 27u: { v = vec4<u32>(0x0b0c0e10u, 0x0708080au, 0x04050506u, 0x03030404u); }
        case 28u: { v = vec4<u32>(0x27272727u, 0x23252627u, 0x191c1f21u, 0x10121417u); }
        case 29u: { v = vec4<u32>(0x0a0b0c0eu, 0x06070809u, 0x04040505u, 0x03030304u); }
        case 30u: { v = vec4<u32>(0x1e1e1e1eu, 0x1c1d1d1eu, 0x1517191au, 0x0e0f1113u); }
        case 31u: { v = vec4<u32>(0x080a0b0cu, 0x05060708u, 0x04040405u, 0x02030303u); }
        case 32u: { v = vec4<u32>(0x16161616u, 0x15161616u, 0x11121415u, 0x0c0d0e10u); }
        case 33u: { v = vec4<u32>(0x0708090au, 0x05050607u, 0x03030404u, 0x02020303u); }
        case 34u: { v = vec4<u32>(0x11111111u, 0x10111111u, 0x0e0f0f10u, 0x0a0b0c0du); }
        case 35u: { v = vec4<u32>(0x06070809u, 0x04050506u, 0x03030304u, 0x02020202u); }
        case 36u: { v = vec4<u32>(0x0c0c0c0cu, 0x0c0c0c0cu, 0x0b0b0c0cu, 0x0809090au); }
        case 37u: { v = vec4<u32>(0x05060607u, 0x03040405u, 0x02030303u, 0x02020202u); }
        case 38u: { v = vec4<u32>(0x09090909u, 0x09090909u, 0x08080909u, 0x06070708u); }
        case 39u: { v = vec4<u32>(0x04050506u, 0x03030404u, 0x02020203u, 0x01010202u); }
        case 40u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x06060606u, 0x05050606u); }
        case 41u: { v = vec4<u32>(0x04040405u, 0x02030303u, 0x02020202u, 0x01010101u); }
        case 42u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04050505u, 0x04040404u); }
        case 43u: { v = vec4<u32>(0x03030304u, 0x02020203u, 0x01020202u, 0x01010101u); }
        case 44u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 45u: { v = vec4<u32>(0x02020303u, 0x02020202u, 0x01010101u, 0x01010101u); }
        case 46u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 47u: { v = vec4<u32>(0x02020202u, 0x01010102u, 0x01010101u, 0x01010101u); }
        case 48u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x02010101u, 0x02020202u); }
        case 49u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 50u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 51u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00000001u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x01010000u, 0x01010101u, 0x01010101u); }
        case 53u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00000001u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 8u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xc9e0f4ffu, 0x74869bb1u, 0x3f495563u, 0x23282f36u); }
        case 1u: { v = vec4<u32>(0x15181b1fu, 0x0e0f1113u, 0x0a0a0b0cu, 0x08080809u); }
        case 2u: { v = vec4<u32>(0xcbe2f0fdu, 0x74879cb2u, 0x3f495664u, 0x23282f36u); }
        case 3u: { v = vec4<u32>(0x15181b1fu, 0x0e0f1113u, 0x0a0a0b0cu, 0x07080809u); }
        case 4u: { v = vec4<u32>(0xccdff1f6u, 0x75889eb5u, 0x3f4a5664u, 0x23282f36u); }
        case 5u: { v = vec4<u32>(0x15181b1fu, 0x0d0f1112u, 0x0a0a0b0cu, 0x07080809u); }
        case 6u: { v = vec4<u32>(0xcaddeaecu, 0x76899fb5u, 0x3f4a5665u, 0x23282f36u); }
        case 7u: { v = vec4<u32>(0x15171b1eu, 0x0d0f1012u, 0x090a0b0cu, 0x07080809u); }
        case 8u: { v = vec4<u32>(0xc5d6dddeu, 0x76899db2u, 0x3f4a5765u, 0x23282f36u); }
        case 9u: { v = vec4<u32>(0x14171a1eu, 0x0d0f1012u, 0x090a0b0cu, 0x07080809u); }
        case 10u: { v = vec4<u32>(0xbdc9cdcdu, 0x758699acu, 0x3f495664u, 0x22282e36u); }
        case 11u: { v = vec4<u32>(0x14171a1eu, 0x0d0e1012u, 0x090a0b0cu, 0x07070808u); }
        case 12u: { v = vec4<u32>(0xb0b8babau, 0x718293a3u, 0x3e485462u, 0x22272d35u); }
        case 13u: { v = vec4<u32>(0x14161a1du, 0x0d0e1012u, 0x090a0a0bu, 0x07070808u); }
        case 14u: { v = vec4<u32>(0xa0a5a6a7u, 0x6c7b8996u, 0x3c46515eu, 0x21262c34u); }
        case 15u: { v = vec4<u32>(0x1316191du, 0x0c0e0f11u, 0x08090a0bu, 0x06070708u); }
        case 16u: { v = vec4<u32>(0x8e919292u, 0x65727e87u, 0x3a434d59u, 0x20252b32u); }
        case 17u: { v = vec4<u32>(0x1315181cu, 0x0c0d0f10u, 0x08090a0bu, 0x06060707u); }
        case 18u: { v = vec4<u32>(0x7c7e7e7eu, 0x5c677077u, 0x363f4852u, 0x1e23292fu); }
        case 19u: { v = vec4<u32>(0x1214171au, 0x0b0d0e10u, 0x0808090au, 0x06060607u); }
        case 20u: { v = vec4<u32>(0x6a6b6b6bu, 0x535b6267u, 0x323a424au, 0x1d21262cu); }
        case 21u: { v = vec4<u32>(0x11131619u, 0x0b0c0d0fu, 0x0708090au, 0x05060607u); }
        case 22u: { v = vec4<u32>(0x58595a5au, 0x484e5357u, 0x2e343b42u, 0x1b1f2328u); }
        case 23u: { v = vec4<u32>(0x10121417u, 0x0a0b0c0eu, 0x07070809u, 0x05050606u); }
        case 24u: { v = vec4<u32>(0x49494a4au, 0x3e424648u, 0x292e3439u, 0x181c2024u); }
        case 25u: { v = vec4<u32>(0x0f111315u, 0x090a0c0du, 0x06070708u, 0x04050506u); }
        case 26u: { v = vec4<u32>(0x3b3b3b3cu, 0x3437393au, 0x24282c30u, 0x16191c20u); }
        case 27u: { v = vec4<u32>(0x0d0f1113u, 0x08090b0cu, 0x06060708u, 0x04040505u); }
        case 28u: { v = vec4<u32>(0x2f2f2f2fu, 0x2b2d2e2fu, 0x1f222528u, 0x1416191cu); }
        case 29u: { v = vec4<u32>(0x0c0e0f11u, 0x08090a0bu, 0x05060607u, 0x04040405u); }
        case 30u: { v = vec4<u32>(0x25252525u, 0x22242425u, 0x1a1d1f21u, 0x11131518u); }
        case 31u: { v = vec4<u32>(0x0b0c0e0fu, 0x0708090au, 0x05050606u, 0x03030404u); }
        case 32u: { v = vec4<u32>(0x1d1d1d1du, 0x1b1c1c1cu, 0x1617191au, 0x0f101214u); }
        case 33u: { v = vec4<u32>(0x090b0c0du, 0x06070808u, 0x04040505u, 0x03030304u); }
        case 34u: { v = vec4<u32>(0x16161616u, 0x15151616u, 0x12131414u, 0x0c0e0f10u); }
        case 35u: { v = vec4<u32>(0x08090a0bu, 0x05060707u, 0x04040405u, 0x02030303u); }
        case 36u: { v = vec4<u32>(0x10101010u, 0x10101010u, 0x0e0f0f10u, 0x0a0b0c0du); }
        case 37u: { v = vec4<u32>(0x07080909u, 0x05050606u, 0x03030404u, 0x02020303u); }
        case 38u: { v = vec4<u32>(0x0c0c0c0cu, 0x0c0c0c0cu, 0x0b0b0c0cu, 0x08090a0au); }
        case 39u: { v = vec4<u32>(0x06060708u, 0x04040505u, 0x03030304u, 0x02020202u); }
        case 40u: { v = vec4<u32>(0x09090909u, 0x09090909u, 0x08090909u, 0x07070808u); }
        case 41u: { v = vec4<u32>(0x05050606u, 0x03040404u, 0x02020303u, 0x02020202u); }
        case 42u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x06060606u, 0x05060606u); }
        case 43u: { v = vec4<u32>(0x04040505u, 0x03030304u, 0x02020203u, 0x01010202u); }
        case 44u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04050504u, 0x04040404u); }
        case 45u: { v = vec4<u32>(0x03030404u, 0x02020303u, 0x02020202u, 0x01010101u); }
        case 46u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 47u: { v = vec4<u32>(0x02030303u, 0x02020202u, 0x01010202u, 0x01010101u); }
        case 48u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 49u: { v = vec4<u32>(0x02020202u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 50u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02020201u); }
        case 51u: { v = vec4<u32>(0x01010102u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 52u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 53u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00000101u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01010000u, 0x01010101u); }
        case 55u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00010101u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 9u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xcce2f5ffu, 0x7a8ca0b5u, 0x444f5b69u, 0x272d333bu); }
        case 1u: { v = vec4<u32>(0x181b1e22u, 0x10111315u, 0x0b0c0d0eu, 0x09090a0bu); }
        case 2u: { v = vec4<u32>(0xcee4f1fdu, 0x7a8ca1b7u, 0x444f5b6au, 0x272d333bu); }
        case 3u: { v = vec4<u32>(0x181b1e22u, 0x10111315u, 0x0b0c0d0eu, 0x09090a0bu); }
        case 4u: { v = vec4<u32>(0xcfe1f2f7u, 0x7b8ea3b9u, 0x454f5c6au, 0x272d333bu); }
        case 5u: { v = vec4<u32>(0x181b1e22u, 0x10111315u, 0x0b0c0d0eu, 0x09090a0au); }
        case 6u: { v = vec4<u32>(0xcddfecedu, 0x7c8fa4b9u, 0x45505c6bu, 0x272d343bu); }
        case 7u: { v = vec4<u32>(0x181b1e22u, 0x0f111315u, 0x0b0c0d0eu, 0x09090a0au); }
        case 8u: { v = vec4<u32>(0xc9d9e0e1u, 0x7c8fa3b6u, 0x45505d6bu, 0x272d333bu); }
        case 9u: { v = vec4<u32>(0x171a1e22u, 0x0f111315u, 0x0b0c0d0eu, 0x0809090au); }
        case 10u: { v = vec4<u32>(0xc2cdd1d1u, 0x7b8d9fb1u, 0x444f5c6bu, 0x272c333bu); }
        case 11u: { v = vec4<u32>(0x171a1e22u, 0x0f111215u, 0x0b0b0c0eu, 0x0809090au); }
        case 12u: { v = vec4<u32>(0xb6bdc0c0u, 0x788899a9u, 0x444e5b68u, 0x262c323au); }
        case 13u: { v = vec4<u32>(0x171a1d21u, 0x0f101214u, 0x0a0b0c0du, 0x0808090au); }
        case 14u: { v = vec4<u32>(0xa7abadadu, 0x7381909du, 0x424c5865u, 0x252b3139u); }
        case 15u: { v = vec4<u32>(0x16191c20u, 0x0e101214u, 0x0a0b0c0du, 0x07080909u); }
        case 16u: { v = vec4<u32>(0x96999a9au, 0x6c79858fu, 0x3f49545fu, 0x24293037u); }
        case 17u: { v = vec4<u32>(0x15181c1fu, 0x0e0f1113u, 0x0a0a0b0cu, 0x07080809u); }
        case 18u: { v = vec4<u32>(0x84868687u, 0x646e787fu, 0x3c454f59u, 0x23282e34u); }
        case 19u: { v = vec4<u32>(0x15171b1eu, 0x0d0f1012u, 0x090a0b0cu, 0x07070808u); }
        case 20u: { v = vec4<u32>(0x72747474u, 0x5a636a6fu, 0x38404851u, 0x21252b31u); }
        case 21u: { v = vec4<u32>(0x1416191du, 0x0c0e1011u, 0x09090a0bu, 0x06070708u); }
        case 22u: { v = vec4<u32>(0x61626262u, 0x50575c5fu, 0x343a4249u, 0x1f23282du); }
        case 23u: { v = vec4<u32>(0x1215181bu, 0x0c0d0f10u, 0x08090a0bu, 0x06060707u); }
        case 24u: { v = vec4<u32>(0x51525252u, 0x464a4e50u, 0x2f343a40u, 0x1c202429u); }
        case 25u: { v = vec4<u32>(0x11131619u, 0x0b0c0e0fu, 0x0708090au, 0x05060607u); }
        case 26u: { v = vec4<u32>(0x43444444u, 0x3b3e4142u, 0x292e3337u, 0x1a1d2125u); }
        case 27u: { v = vec4<u32>(0x10121417u, 0x0a0b0d0eu, 0x07070809u, 0x05050606u); }
        case 28u: { v = vec4<u32>(0x37373737u, 0x31343536u, 0x24282b2fu, 0x171a1d20u); }
        case 29u: { v = vec4<u32>(0x0e101215u, 0x090a0b0du, 0x06070808u, 0x04050506u); }
        case 30u: { v = vec4<u32>(0x2c2c2c2cu, 0x282a2b2bu, 0x1f222427u, 0x1417191cu); }
        case 31u: { v = vec4<u32>(0x0d0e1012u, 0x08090a0cu, 0x06060708u, 0x04040505u); }
        case 32u: { v = vec4<u32>(0x22222222u, 0x21212222u, 0x1a1c1e1fu, 0x12141618u); }
        case 33u: { v = vec4<u32>(0x0b0d0e10u, 0x0708090au, 0x05050607u, 0x03040405u); }
        case 34u: { v = vec4<u32>(0x1b1b1b1bu, 0x1a1a1a1bu, 0x15171819u, 0x0f111214u); }
        case 35u: { v = vec4<u32>(0x0a0b0c0eu, 0x07070809u, 0x04050506u, 0x03030404u); }
        case 36u: { v = vec4<u32>(0x14141414u, 0x14141414u, 0x11121314u, 0x0d0e0f10u); }
        case 37u: { v = vec4<u32>(0x090a0b0cu, 0x06060708u, 0x04040505u, 0x03030304u); }
        case 38u: { v = vec4<u32>(0x0f0f0f0fu, 0x0f0f0f0fu, 0x0e0e0f0fu, 0x0a0b0c0du); }
        case 39u: { v = vec4<u32>(0x0708090au, 0x05050607u, 0x03040404u, 0x02030303u); }
        case 40u: { v = vec4<u32>(0x0b0b0b0bu, 0x0b0b0b0bu, 0x0b0b0b0bu, 0x08090a0au); }
        case 41u: { v = vec4<u32>(0x06070708u, 0x04050506u, 0x03030304u, 0x02020203u); }
        case 42u: { v = vec4<u32>(0x08080808u, 0x08080808u, 0x08080808u, 0x07070708u); }
        case 43u: { v = vec4<u32>(0x05050606u, 0x04040405u, 0x02030303u, 0x02020202u); }
        case 44u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x06060606u, 0x05050606u); }
        case 45u: { v = vec4<u32>(0x04040505u, 0x03030304u, 0x02020203u, 0x01020202u); }
        case 46u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04040404u, 0x04040404u); }
        case 47u: { v = vec4<u32>(0x03030404u, 0x02030303u, 0x02020202u, 0x01010102u); }
        case 48u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 49u: { v = vec4<u32>(0x02030303u, 0x02020202u, 0x01010202u, 0x01010101u); }
        case 50u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 51u: { v = vec4<u32>(0x02020202u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 52u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 53u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 54u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 55u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00010101u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x01010100u); }
        case 57u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00010101u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 10u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xcfe4f6ffu, 0x7e90a4b9u, 0x4954606eu, 0x2b313840u); }
        case 1u: { v = vec4<u32>(0x1a1e2126u, 0x12131518u, 0x0d0e0f10u, 0x0a0b0b0cu); }
        case 2u: { v = vec4<u32>(0xd0e5f1fdu, 0x7f91a5bau, 0x4954606fu, 0x2b313840u); }
        case 3u: { v = vec4<u32>(0x1a1e2126u, 0x12131518u, 0x0d0e0f10u, 0x0a0b0b0cu); }
        case 4u: { v = vec4<u32>(0xd2e3f3f8u, 0x8092a7bcu, 0x4954616fu, 0x2b313840u); }
        case 5u: { v = vec4<u32>(0x1a1e2126u, 0x12131518u, 0x0d0e0f10u, 0x0a0b0b0cu); }
        case 6u: { v = vec4<u32>(0xcfe1edefu, 0x8194a8bcu, 0x49556170u, 0x2b313840u); }
        case 7u: { v = vec4<u32>(0x1a1d2126u, 0x11131518u, 0x0d0e0f10u, 0x0a0a0b0cu); }
        case 8u: { v = vec4<u32>(0xccdbe2e3u, 0x8194a7bau, 0x4a556271u, 0x2b313840u); }
        case 9u: { v = vec4<u32>(0x1a1d2125u, 0x11131517u, 0x0c0d0e10u, 0x0a0a0b0cu); }
        case 10u: { v = vec4<u32>(0xc5d0d4d4u, 0x8091a3b5u, 0x49546170u, 0x2a303740u); }
        case 11u: { v = vec4<u32>(0x1a1d2125u, 0x11131517u, 0x0c0d0e0fu, 0x090a0a0bu); }
        case 12u: { v = vec4<u32>(0xbac1c4c4u, 0x7d8d9eadu, 0x4853606eu, 0x2a30373fu); }
        case 13u: { v = vec4<u32>(0x191d2025u, 0x11121417u, 0x0c0d0e0fu, 0x090a0a0bu); }
        case 14u: { v = vec4<u32>(0xacb1b2b2u, 0x788795a2u, 0x47515d6au, 0x292f363eu); }
        case 15u: { v = vec4<u32>(0x191c2024u, 0x10121416u, 0x0b0c0d0fu, 0x09090a0bu); }
        case 16u: { v = vec4<u32>(0x9b9fa0a0u, 0x727f8b95u, 0x444e5965u, 0x282d343cu); }
        case 17u: { v = vec4<u32>(0x181b1f23u, 0x10111315u, 0x0b0c0d0eu, 0x0809090au); }
        case 18u: { v = vec4<u32>(0x8a8c8d8du, 0x6a757e86u, 0x414a545fu, 0x262c3239u); }
        case 19u: { v = vec4<u32>(0x171a1e22u, 0x0f111215u, 0x0a0b0c0eu, 0x0808090au); }
        case 20u: { v = vec4<u32>(0x797b7b7bu, 0x61697176u, 0x3d454e57u, 0x24292f36u); }
        case 21u: { v = vec4<u32>(0x16191c20u, 0x0e101214u, 0x0a0b0c0du, 0x07080809u); }
        case 22u: { v = vec4<u32>(0x68696a6au, 0x575d6366u, 0x3940474fu, 0x22272c32u); }
        case 23u: { v = vec4<u32>(0x15181b1eu, 0x0d0f1113u, 0x090a0b0cu, 0x07070808u); }
        case 24u: { v = vec4<u32>(0x59595959u, 0x4c515557u, 0x343a4046u, 0x2024292eu); }
        case 25u: { v = vec4<u32>(0x1416191cu, 0x0d0e1011u, 0x09090a0bu, 0x06070708u); }
        case 26u: { v = vec4<u32>(0x4a4b4b4bu, 0x42454849u, 0x2e33383du, 0x1d212529u); }
        case 27u: { v = vec4<u32>(0x1214171au, 0x0c0d0e10u, 0x08090a0bu, 0x06060707u); }
        case 28u: { v = vec4<u32>(0x3d3d3d3du, 0x373a3c3du, 0x292d3134u, 0x1a1d2125u); }
        case 29u: { v = vec4<u32>(0x11131517u, 0x0b0c0d0fu, 0x0708090au, 0x05060607u); }
        case 30u: { v = vec4<u32>(0x32323232u, 0x2e303131u, 0x2326292cu, 0x171a1d20u); }
        case 31u: { v = vec4<u32>(0x0f111315u, 0x0a0b0c0du, 0x07070809u, 0x05050506u); }
        case 32u: { v = vec4<u32>(0x28282828u, 0x26272728u, 0x1e202224u, 0x1517191cu); }
        case 33u: { v = vec4<u32>(0x0d0f1113u, 0x090a0b0cu, 0x06070708u, 0x04040505u); }
        case 34u: { v = vec4<u32>(0x1f1f1f1fu, 0x1e1f1f1fu, 0x191b1c1du, 0x12141517u); }
        case 35u: { v = vec4<u32>(0x0c0d0f10u, 0x08090a0bu, 0x05060607u, 0x04040405u); }
        case 36u: { v = vec4<u32>(0x18181818u, 0x18181818u, 0x14161617u, 0x0f101213u); }
        case 37u: { v = vec4<u32>(0x0a0b0d0eu, 0x07080809u, 0x05050606u, 0x03040404u); }
        case 38u: { v = vec4<u32>(0x13131313u, 0x12121313u, 0x10111212u, 0x0d0e0f10u); }
        case 39u: { v = vec4<u32>(0x090a0b0cu, 0x06070708u, 0x04040505u, 0x03030304u); }
        case 40u: { v = vec4<u32>(0x0e0e0e0eu, 0x0e0e0e0eu, 0x0d0d0e0eu, 0x0a0b0c0cu); }
        case 41u: { v = vec4<u32>(0x0708090au, 0x05060607u, 0x04040405u, 0x02030303u); }
        case 42u: { v = vec4<u32>(0x0a0a0a0au, 0x0a0a0a0au, 0x0a0a0a0au, 0x0809090au); }
        case 43u: { v = vec4<u32>(0x06070708u, 0x04050506u, 0x03030404u, 0x02020203u); }
        case 44u: { v = vec4<u32>(0x07070707u, 0x07070707u, 0x07070808u, 0x06070707u); }
        case 45u: { v = vec4<u32>(0x05050606u, 0x04040405u, 0x03030303u, 0x02020202u); }
        case 46u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x05050505u, 0x05050505u); }
        case 47u: { v = vec4<u32>(0x04040505u, 0x03030304u, 0x02020303u, 0x01020202u); }
        case 48u: { v = vec4<u32>(0x03030303u, 0x04040403u, 0x04040404u, 0x04040404u); }
        case 49u: { v = vec4<u32>(0x03030304u, 0x02030303u, 0x02020202u, 0x01010102u); }
        case 50u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x03030302u, 0x03030303u); }
        case 51u: { v = vec4<u32>(0x02020303u, 0x02020202u, 0x01020202u, 0x01010101u); }
        case 52u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x02020202u, 0x02020202u); }
        case 53u: { v = vec4<u32>(0x02020202u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 54u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 55u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01010100u, 0x01010101u); }
        case 57u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x01010101u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 11u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd1e5f6ffu, 0x8294a7bcu, 0x4d586472u, 0x2e343b43u); }
        case 1u: { v = vec4<u32>(0x1d202429u, 0x1315171au, 0x0e0f1012u, 0x0b0c0d0du); }
        case 2u: { v = vec4<u32>(0xd2e6f1fdu, 0x8395a8bdu, 0x4d586473u, 0x2e343b43u); }
        case 3u: { v = vec4<u32>(0x1d202429u, 0x1315171au, 0x0e0f1012u, 0x0b0c0d0du); }
        case 4u: { v = vec4<u32>(0xd3e4f3f8u, 0x8496aabfu, 0x4d586573u, 0x2e343b44u); }
        case 5u: { v = vec4<u32>(0x1d202429u, 0x1315171au, 0x0e0f1012u, 0x0b0c0c0du); }
        case 6u: { v = vec4<u32>(0xd1e2eef0u, 0x8597abbfu, 0x4d596674u, 0x2e343b44u); }
        case 7u: { v = vec4<u32>(0x1d202428u, 0x1315171au, 0x0e0f1012u, 0x0b0c0c0du); }
        case 8u: { v = vec4<u32>(0xcedde4e4u, 0x8597aabdu, 0x4e596675u, 0x2e343b44u); }
        case 9u: { v = vec4<u32>(0x1c202428u, 0x1315171au, 0x0e0f1011u, 0x0b0b0c0du); }
        case 10u: { v = vec4<u32>(0xc8d3d6d7u, 0x8495a7b8u, 0x4d596674u, 0x2d343b43u); }
        case 11u: { v = vec4<u32>(0x1c1f2328u, 0x13151719u, 0x0d0e1011u, 0x0a0b0c0du); }
        case 12u: { v = vec4<u32>(0xbdc5c7c7u, 0x8191a1b1u, 0x4c586472u, 0x2d333a43u); }
        case 13u: { v = vec4<u32>(0x1c1f2328u, 0x12141619u, 0x0d0e0f11u, 0x0a0b0b0cu); }
        case 14u: { v = vec4<u32>(0xb0b4b6b6u, 0x7d8b9aa6u, 0x4b56626fu, 0x2c323942u); }
        case 15u: { v = vec4<u32>(0x1b1e2227u, 0x12141618u, 0x0d0e0f10u, 0x0a0a0b0cu); }
        case 16u: { v = vec4<u32>(0xa0a3a4a4u, 0x7784909au, 0x49535e6au, 0x2b313840u); }
        case 17u: { v = vec4<u32>(0x1a1e2126u, 0x11131518u, 0x0c0d0e10u, 0x090a0a0bu); }
        case 18u: { v = vec4<u32>(0x90929292u, 0x6f7a848bu, 0x454f5964u, 0x292f363du); }
        case 19u: { v = vec4<u32>(0x191d2025u, 0x11121417u, 0x0c0d0e0fu, 0x09090a0bu); }
        case 20u: { v = vec4<u32>(0x7f808181u, 0x666f767cu, 0x424a535cu, 0x282d333au); }
        case 21u: { v = vec4<u32>(0x181b1f23u, 0x10121416u, 0x0b0c0d0eu, 0x0809090au); }
        case 22u: { v = vec4<u32>(0x6e6f7070u, 0x5c63686cu, 0x3d444c54u, 0x252a3036u); }
        case 23u: { v = vec4<u32>(0x171a1d21u, 0x0f111315u, 0x0a0b0c0eu, 0x0808090au); }
        case 24u: { v = vec4<u32>(0x5f5f5f5fu, 0x51575b5du, 0x383e454bu, 0x23272c32u); }
        case 25u: { v = vec4<u32>(0x16181b1fu, 0x0e101113u, 0x0a0b0c0du, 0x07080809u); }
        case 26u: { v = vec4<u32>(0x50505151u, 0x474b4d4fu, 0x32383d42u, 0x2024282du); }
        case 27u: { v = vec4<u32>(0x1417191du, 0x0d0f1012u, 0x090a0b0cu, 0x06070808u); }
        case 28u: { v = vec4<u32>(0x43434343u, 0x3d3f4142u, 0x2d313539u, 0x1d212428u); }
        case 29u: { v = vec4<u32>(0x1315171au, 0x0c0d0f11u, 0x08090a0bu, 0x06060708u); }
        case 30u: { v = vec4<u32>(0x37373737u, 0x33353637u, 0x272a2e30u, 0x1a1d2024u); }
        case 31u: { v = vec4<u32>(0x11131518u, 0x0b0c0e0fu, 0x0808090au, 0x05060607u); }
        case 32u: { v = vec4<u32>(0x2d2d2d2du, 0x2a2b2c2cu, 0x21242628u, 0x171a1c1fu); }
        case 33u: { v = vec4<u32>(0x0f111315u, 0x0a0b0c0eu, 0x07070809u, 0x05050606u); }
        case 34u: { v = vec4<u32>(0x24242424u, 0x22232323u, 0x1c1e2021u, 0x1416181au); }
        case 35u: { v = vec4<u32>(0x0e0f1112u, 0x090a0b0cu, 0x06070708u, 0x04050506u); }
        case 36u: { v = vec4<u32>(0x1c1c1c1cu, 0x1b1c1c1cu, 0x17191a1bu, 0x11131416u); }
        case 37u: { v = vec4<u32>(0x0c0d0e10u, 0x08090a0bu, 0x05060707u, 0x04040505u); }
        case 38u: { v = vec4<u32>(0x16161616u, 0x15151616u, 0x13141415u, 0x0f101112u); }
        case 39u: { v = vec4<u32>(0x0a0b0c0du, 0x07080809u, 0x05050606u, 0x03040404u); }
        case 40u: { v = vec4<u32>(0x10101010u, 0x10101010u, 0x0f101010u, 0x0c0d0e0eu); }
        case 41u: { v = vec4<u32>(0x09090a0bu, 0x06070708u, 0x04050505u, 0x03030304u); }
        case 42u: { v = vec4<u32>(0x0c0c0c0cu, 0x0c0c0c0cu, 0x0c0c0c0cu, 0x0a0a0b0bu); }
        case 43u: { v = vec4<u32>(0x07080809u, 0x05060607u, 0x04040405u, 0x02030303u); }
        case 44u: { v = vec4<u32>(0x09090909u, 0x09090909u, 0x09090909u, 0x08080809u); }
        case 45u: { v = vec4<u32>(0x06060707u, 0x04050506u, 0x03030404u, 0x02020303u); }
        case 46u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x07070707u, 0x06060606u); }
        case 47u: { v = vec4<u32>(0x05050506u, 0x04040404u, 0x03030303u, 0x02020202u); }
        case 48u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x05050505u, 0x04050505u); }
        case 49u: { v = vec4<u32>(0x04040404u, 0x03030304u, 0x02020203u, 0x01020202u); }
        case 50u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 51u: { v = vec4<u32>(0x03030303u, 0x02020303u, 0x02020202u, 0x01010102u); }
        case 52u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 53u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01010202u, 0x01010101u); }
        case 54u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02010101u); }
        case 55u: { v = vec4<u32>(0x02020202u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 57u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x01000000u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00000101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 12u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd2e6f6ffu, 0x8597aabeu, 0x505b6776u, 0x30373e46u); }
        case 1u: { v = vec4<u32>(0x1f22262bu, 0x1517191cu, 0x0f111213u, 0x0c0d0e0fu); }
        case 2u: { v = vec4<u32>(0xd4e7f2fdu, 0x8697abbfu, 0x505b6876u, 0x31373e46u); }
        case 3u: { v = vec4<u32>(0x1f22262bu, 0x1517191cu, 0x0f111213u, 0x0c0d0e0eu); }
        case 4u: { v = vec4<u32>(0xd5e4f4f8u, 0x8799adc1u, 0x505b6877u, 0x31373e47u); }
        case 5u: { v = vec4<u32>(0x1f22262bu, 0x1517191cu, 0x0f101213u, 0x0c0d0e0eu); }
        case 6u: { v = vec4<u32>(0xd3e3eff0u, 0x889aaec1u, 0x515c6978u, 0x30373e47u); }
        case 7u: { v = vec4<u32>(0x1f22262bu, 0x1517191cu, 0x0f101213u, 0x0c0d0d0eu); }
        case 8u: { v = vec4<u32>(0xd0dee5e5u, 0x889aadbfu, 0x515c6978u, 0x30373e47u); }
        case 9u: { v = vec4<u32>(0x1e22262bu, 0x1517191bu, 0x0f101113u, 0x0c0c0d0eu); }
        case 10u: { v = vec4<u32>(0xcad4d8d8u, 0x8798aabau, 0x515c6978u, 0x30363e47u); }
        case 11u: { v = vec4<u32>(0x1e22262bu, 0x1416181bu, 0x0f101113u, 0x0b0c0d0eu); }
        case 12u: { v = vec4<u32>(0xc0c7c9c9u, 0x8594a4b4u, 0x505b6876u, 0x30363d46u); }
        case 13u: { v = vec4<u32>(0x1e21252au, 0x1416181bu, 0x0e0f1112u, 0x0b0c0c0du); }
        case 14u: { v = vec4<u32>(0xb3b7b9b9u, 0x808f9daau, 0x4e596572u, 0x2f353c45u); }
        case 15u: { v = vec4<u32>(0x1d212529u, 0x1315181au, 0x0e0f1012u, 0x0b0b0c0du); }
        case 16u: { v = vec4<u32>(0xa4a7a8a8u, 0x7a87939du, 0x4c56626eu, 0x2e343b43u); }
        case 17u: { v = vec4<u32>(0x1c202428u, 0x13151719u, 0x0d0e1011u, 0x0a0b0b0cu); }
        case 18u: { v = vec4<u32>(0x93969696u, 0x737e878fu, 0x49525d68u, 0x2c323940u); }
        case 19u: { v = vec4<u32>(0x1b1f2327u, 0x12141619u, 0x0d0e0f10u, 0x0a0a0b0cu); }
        case 20u: { v = vec4<u32>(0x83848585u, 0x6a737a80u, 0x454e5760u, 0x2a30363du); }
        case 21u: { v = vec4<u32>(0x1a1e2125u, 0x11131518u, 0x0c0d0e10u, 0x090a0a0bu); }
        case 22u: { v = vec4<u32>(0x73747474u, 0x60676d71u, 0x40485058u, 0x282d3339u); }
        case 23u: { v = vec4<u32>(0x191c2024u, 0x10121416u, 0x0b0c0e0fu, 0x08090a0bu); }
        case 24u: { v = vec4<u32>(0x63646464u, 0x565b5f62u, 0x3b424950u, 0x262a2f35u); }
        case 25u: { v = vec4<u32>(0x181a1e21u, 0x10111315u, 0x0b0c0d0eu, 0x0808090au); }
        case 26u: { v = vec4<u32>(0x55555555u, 0x4b4f5254u, 0x363b4146u, 0x23272b31u); }
        case 27u: { v = vec4<u32>(0x16191c1fu, 0x0e101214u, 0x0a0b0c0du, 0x07080809u); }
        case 28u: { v = vec4<u32>(0x47484848u, 0x41444547u, 0x3035393du, 0x2023272cu); }
        case 29u: { v = vec4<u32>(0x1417191cu, 0x0d0f1012u, 0x090a0b0cu, 0x07070808u); }
        case 30u: { v = vec4<u32>(0x3b3c3c3cu, 0x37393a3bu, 0x2a2e3134u, 0x1d202327u); }
        case 31u: { v = vec4<u32>(0x1315171au, 0x0c0e0f11u, 0x08090a0bu, 0x06060708u); }
        case 32u: { v = vec4<u32>(0x31313131u, 0x2e2f3030u, 0x25272a2cu, 0x191c1f22u); }
        case 33u: { v = vec4<u32>(0x11131517u, 0x0b0c0e0fu, 0x0808090au, 0x05060607u); }
        case 34u: { v = vec4<u32>(0x27272727u, 0x25262727u, 0x1f212324u, 0x16181b1du); }
        case 35u: { v = vec4<u32>(0x0f111214u, 0x0a0b0c0eu, 0x07080809u, 0x05050606u); }
        case 36u: { v = vec4<u32>(0x1f1f1f1fu, 0x1e1f1f1fu, 0x1a1b1d1eu, 0x13151718u); }
        case 37u: { v = vec4<u32>(0x0d0f1012u, 0x090a0b0cu, 0x06070708u, 0x04050506u); }
        case 38u: { v = vec4<u32>(0x18181818u, 0x18181818u, 0x15161718u, 0x10121314u); }
        case 39u: { v = vec4<u32>(0x0b0d0e0fu, 0x08090a0au, 0x05060707u, 0x04040505u); }
        case 40u: { v = vec4<u32>(0x13131313u, 0x13131313u, 0x11121212u, 0x0e0f0f10u); }
        case 41u: { v = vec4<u32>(0x0a0b0c0du, 0x07080809u, 0x05050606u, 0x03040404u); }
        case 42u: { v = vec4<u32>(0x0e0e0e0eu, 0x0e0e0e0eu, 0x0d0e0e0eu, 0x0b0c0c0du); }
        case 43u: { v = vec4<u32>(0x08090a0au, 0x06060708u, 0x04040505u, 0x03030304u); }
        case 44u: { v = vec4<u32>(0x0a0a0a0au, 0x0b0b0a0au, 0x0a0a0b0bu, 0x09090a0au); }
        case 45u: { v = vec4<u32>(0x07070808u, 0x05050606u, 0x03040405u, 0x02030303u); }
        case 46u: { v = vec4<u32>(0x07070707u, 0x08080807u, 0x08080808u, 0x07070708u); }
        case 47u: { v = vec4<u32>(0x06060607u, 0x04040505u, 0x03030304u, 0x02020203u); }
        case 48u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x06060505u, 0x05050506u); }
        case 49u: { v = vec4<u32>(0x04050505u, 0x03040404u, 0x02030303u, 0x02020202u); }
        case 50u: { v = vec4<u32>(0x03030303u, 0x04040303u, 0x04040404u, 0x04040404u); }
        case 51u: { v = vec4<u32>(0x03040404u, 0x03030303u, 0x02020203u, 0x01020202u); }
        case 52u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x03020202u, 0x03030303u); }
        case 53u: { v = vec4<u32>(0x03030303u, 0x02020202u, 0x02020202u, 0x01010101u); }
        case 54u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x02020101u, 0x02020202u); }
        case 55u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01010101u, 0x01010101u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 57u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x01010100u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 13u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd3e6f7ffu, 0x8899acbfu, 0x525d6a78u, 0x33394049u); }
        case 1u: { v = vec4<u32>(0x2124282du, 0x16181b1du, 0x11121315u, 0x0d0e0f10u); }
        case 2u: { v = vec4<u32>(0xd5e8f2fdu, 0x889aacc0u, 0x535e6a78u, 0x33394049u); }
        case 3u: { v = vec4<u32>(0x2124282du, 0x16181b1du, 0x11121315u, 0x0d0e0f0fu); }
        case 4u: { v = vec4<u32>(0xd6e5f4f9u, 0x899baec2u, 0x535e6b79u, 0x33394049u); }
        case 5u: { v = vec4<u32>(0x2024282du, 0x16181b1du, 0x10121314u, 0x0d0e0e0fu); }
        case 6u: { v = vec4<u32>(0xd4e4eff1u, 0x8a9cafc2u, 0x535e6b7au, 0x33394149u); }
        case 7u: { v = vec4<u32>(0x2024282du, 0x16181a1du, 0x10111314u, 0x0d0d0e0fu); }
        case 8u: { v = vec4<u32>(0xd1dfe6e6u, 0x8b9caec0u, 0x535f6c7bu, 0x32394149u); }
        case 9u: { v = vec4<u32>(0x2024282du, 0x16181a1du, 0x10111314u, 0x0d0d0e0fu); }
        case 10u: { v = vec4<u32>(0xcbd6d9d9u, 0x8a9babbcu, 0x535f6c7au, 0x32394049u); }
        case 11u: { v = vec4<u32>(0x2023282du, 0x16181a1du, 0x10111214u, 0x0c0d0e0fu); }
        case 12u: { v = vec4<u32>(0xc2c8cbcbu, 0x8797a6b5u, 0x525e6a78u, 0x32384048u); }
        case 13u: { v = vec4<u32>(0x1f23272cu, 0x15171a1cu, 0x0f101213u, 0x0c0d0d0eu); }
        case 14u: { v = vec4<u32>(0xb5b9bbbbu, 0x83919facu, 0x515c6875u, 0x31373f47u); }
        case 15u: { v = vec4<u32>(0x1f22272bu, 0x1517191cu, 0x0f101113u, 0x0b0c0d0eu); }
        case 16u: { v = vec4<u32>(0xa6a9aaaau, 0x7d8a96a0u, 0x4f596470u, 0x30363d45u); }
        case 17u: { v = vec4<u32>(0x1e22262au, 0x1416181bu, 0x0e0f1112u, 0x0b0c0c0du); }
        case 18u: { v = vec4<u32>(0x96989999u, 0x76818a92u, 0x4c55606bu, 0x2e343b43u); }
        case 19u: { v = vec4<u32>(0x1d212429u, 0x1315181au, 0x0e0f1012u, 0x0a0b0c0du); }
        case 20u: { v = vec4<u32>(0x86888888u, 0x6d767e83u, 0x48505a63u, 0x2c323940u); }
        case 21u: { v = vec4<u32>(0x1c1f2327u, 0x13141719u, 0x0d0e0f11u, 0x0a0a0b0cu); }
        case 22u: { v = vec4<u32>(0x76777878u, 0x636a7074u, 0x434b535bu, 0x2a2f353cu); }
        case 23u: { v = vec4<u32>(0x1b1e2126u, 0x12131618u, 0x0c0d0f10u, 0x090a0a0bu); }
        case 24u: { v = vec4<u32>(0x67686868u, 0x595e6365u, 0x3e454c53u, 0x282c3238u); }
        case 25u: { v = vec4<u32>(0x191c2023u, 0x11121417u, 0x0c0d0e0fu, 0x08090a0bu); }
        case 26u: { v = vec4<u32>(0x58595959u, 0x4e525557u, 0x393e444au, 0x25292e33u); }
        case 27u: { v = vec4<u32>(0x181a1d21u, 0x10111315u, 0x0b0c0d0eu, 0x0808090au); }
        case 28u: { v = vec4<u32>(0x4b4b4b4bu, 0x4447494au, 0x33383c40u, 0x22262a2eu); }
        case 29u: { v = vec4<u32>(0x16181b1eu, 0x0e101214u, 0x0a0b0c0du, 0x07080809u); }
        case 30u: { v = vec4<u32>(0x3f3f3f3fu, 0x3a3c3d3eu, 0x2d313437u, 0x1f222529u); }
        case 31u: { v = vec4<u32>(0x1416191cu, 0x0d0f1012u, 0x090a0b0cu, 0x07070808u); }
        case 32u: { v = vec4<u32>(0x34343434u, 0x31323334u, 0x272a2d2fu, 0x1b1e2124u); }
        case 33u: { v = vec4<u32>(0x12141619u, 0x0c0d0f10u, 0x08090a0bu, 0x06060708u); }
        case 34u: { v = vec4<u32>(0x2a2a2a2au, 0x28292a2au, 0x21242627u, 0x181a1d1fu); }
        case 35u: { v = vec4<u32>(0x10121416u, 0x0b0c0d0fu, 0x0808090au, 0x05060607u); }
        case 36u: { v = vec4<u32>(0x22222222u, 0x21212222u, 0x1c1e1f20u, 0x1517191au); }
        case 37u: { v = vec4<u32>(0x0e101113u, 0x0a0b0c0du, 0x07070809u, 0x05050606u); }
        case 38u: { v = vec4<u32>(0x1b1b1b1bu, 0x1a1b1b1bu, 0x1718191au, 0x12131516u); }
        case 39u: { v = vec4<u32>(0x0d0e0f10u, 0x090a0a0bu, 0x06070708u, 0x04050505u); }
        case 40u: { v = vec4<u32>(0x15151515u, 0x15151515u, 0x13131414u, 0x0f101112u); }
        case 41u: { v = vec4<u32>(0x0b0c0d0eu, 0x0808090au, 0x05060607u, 0x04040405u); }
        case 42u: { v = vec4<u32>(0x10101010u, 0x10101010u, 0x0f0f1010u, 0x0c0d0e0eu); }
        case 43u: { v = vec4<u32>(0x090a0b0cu, 0x07070808u, 0x05050506u, 0x03030404u); }
        case 44u: { v = vec4<u32>(0x0c0c0c0cu, 0x0c0c0c0cu, 0x0b0c0c0cu, 0x0a0a0b0bu); }
        case 45u: { v = vec4<u32>(0x08080909u, 0x06060707u, 0x04040505u, 0x03030304u); }
        case 46u: { v = vec4<u32>(0x09090808u, 0x09090909u, 0x09090909u, 0x08080809u); }
        case 47u: { v = vec4<u32>(0x06070707u, 0x05050506u, 0x03040404u, 0x02030303u); }
        case 48u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x06060606u, 0x06060606u); }
        case 49u: { v = vec4<u32>(0x05050606u, 0x04040405u, 0x03030304u, 0x02020203u); }
        case 50u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04040404u, 0x04040404u); }
        case 51u: { v = vec4<u32>(0x04040404u, 0x03030304u, 0x02020303u, 0x02020202u); }
        case 52u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 53u: { v = vec4<u32>(0x03030303u, 0x02030303u, 0x02020202u, 0x01010202u); }
        case 54u: { v = vec4<u32>(0x01010101u, 0x02020201u, 0x02020202u, 0x02020202u); }
        case 55u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01020202u, 0x01010101u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 57u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01000000u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x01010101u, 0x01010101u, 0x00000101u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 14u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd4e7f7ffu, 0x899aadc0u, 0x545f6c7au, 0x343b424au); }
        case 1u: { v = vec4<u32>(0x22252a2fu, 0x17191c1fu, 0x11131416u, 0x0e0f0f10u); }
        case 2u: { v = vec4<u32>(0xd6e8f2fdu, 0x8a9baec1u, 0x545f6c7au, 0x343b424au); }
        case 3u: { v = vec4<u32>(0x22252a2fu, 0x17191c1fu, 0x11131416u, 0x0e0f0f10u); }
        case 4u: { v = vec4<u32>(0xd6e5f4f9u, 0x8b9cafc3u, 0x54606c7bu, 0x343b424bu); }
        case 5u: { v = vec4<u32>(0x22252a2eu, 0x17191c1eu, 0x11121415u, 0x0e0e0f10u); }
        case 6u: { v = vec4<u32>(0xd4e4f0f1u, 0x8c9eb1c3u, 0x55606d7cu, 0x343b424bu); }
        case 7u: { v = vec4<u32>(0x22252a2eu, 0x17191c1eu, 0x11121415u, 0x0d0e0f10u); }
        case 8u: { v = vec4<u32>(0xd2e0e6e7u, 0x8c9eb0c1u, 0x55606e7cu, 0x343b424bu); }
        case 9u: { v = vec4<u32>(0x2125292eu, 0x17191b1eu, 0x11121315u, 0x0d0e0f10u); }
        case 10u: { v = vec4<u32>(0xccd6dadau, 0x8b9cadbdu, 0x55606d7cu, 0x343a424bu); }
        case 11u: { v = vec4<u32>(0x2125292eu, 0x17191b1eu, 0x10121315u, 0x0d0e0e0fu); }
        case 12u: { v = vec4<u32>(0xc3c9ccccu, 0x8998a8b7u, 0x545f6c7au, 0x333a414au); }
        case 13u: { v = vec4<u32>(0x2124292eu, 0x16181b1du, 0x10111314u, 0x0c0d0e0fu); }
        case 14u: { v = vec4<u32>(0xb6bbbcbcu, 0x8593a1adu, 0x535e6a77u, 0x32394049u); }
        case 15u: { v = vec4<u32>(0x2024282du, 0x16181a1du, 0x10111214u, 0x0c0d0e0eu); }
        case 16u: { v = vec4<u32>(0xa8abacacu, 0x7f8c97a1u, 0x515b6672u, 0x31383f47u); }
        case 17u: { v = vec4<u32>(0x1f23272cu, 0x1517191cu, 0x0f101213u, 0x0b0c0d0eu); }
        case 18u: { v = vec4<u32>(0x989a9b9bu, 0x78838c94u, 0x4d57616cu, 0x30363d45u); }
        case 19u: { v = vec4<u32>(0x1e22262bu, 0x1416191bu, 0x0e101112u, 0x0b0c0c0du); }
        case 20u: { v = vec4<u32>(0x888a8a8au, 0x6f788085u, 0x4a525c66u, 0x2e343a42u); }
        case 21u: { v = vec4<u32>(0x1d212429u, 0x1315181au, 0x0e0f1012u, 0x0a0b0c0du); }
        case 22u: { v = vec4<u32>(0x78797a7au, 0x666d7276u, 0x454d555eu, 0x2c31373eu); }
        case 23u: { v = vec4<u32>(0x1c1f2327u, 0x13141719u, 0x0d0e0f11u, 0x0a0a0b0cu); }
        case 24u: { v = vec4<u32>(0x696a6a6au, 0x5b616568u, 0x40474e55u, 0x292e343au); }
        case 25u: { v = vec4<u32>(0x1a1d2125u, 0x12131518u, 0x0c0d0f10u, 0x090a0a0bu); }
        case 26u: { v = vec4<u32>(0x5b5b5b5bu, 0x5155585au, 0x3b40464cu, 0x262b3035u); }
        case 27u: { v = vec4<u32>(0x191c1f22u, 0x10121416u, 0x0b0c0e0fu, 0x08090a0au); }
        case 28u: { v = vec4<u32>(0x4e4e4e4eu, 0x46494b4du, 0x353a3e43u, 0x23272b30u); }
        case 29u: { v = vec4<u32>(0x171a1c20u, 0x0f111315u, 0x0b0c0d0eu, 0x0808090au); }
        case 30u: { v = vec4<u32>(0x41414242u, 0x3c3e4041u, 0x2f33363au, 0x2023272bu); }
        case 31u: { v = vec4<u32>(0x15171a1du, 0x0e101113u, 0x0a0b0c0du, 0x07080809u); }
        case 32u: { v = vec4<u32>(0x36363636u, 0x33343536u, 0x292c2f31u, 0x1d202326u); }
        case 33u: { v = vec4<u32>(0x1315181au, 0x0d0e1011u, 0x090a0b0cu, 0x06070708u); }
        case 34u: { v = vec4<u32>(0x2d2d2d2du, 0x2a2b2c2cu, 0x23252829u, 0x191c1e21u); }
        case 35u: { v = vec4<u32>(0x11131517u, 0x0c0d0e10u, 0x08090a0bu, 0x06060707u); }
        case 36u: { v = vec4<u32>(0x24242424u, 0x23232424u, 0x1e1f2122u, 0x16181a1cu); }
        case 37u: { v = vec4<u32>(0x0f111314u, 0x0a0c0d0eu, 0x0708090au, 0x05060607u); }
        case 38u: { v = vec4<u32>(0x1d1d1d1du, 0x1c1c1d1du, 0x191a1b1bu, 0x13151617u); }
        case 39u: { v = vec4<u32>(0x0d0f1012u, 0x090a0b0cu, 0x06070808u, 0x04050506u); }
        case 40u: { v = vec4<u32>(0x16161616u, 0x16161616u, 0x14151516u, 0x10111213u); }
        case 41u: { v = vec4<u32>(0x0c0d0e0fu, 0x08090a0bu, 0x06060707u, 0x04040505u); }
        case 42u: { v = vec4<u32>(0x11111111u, 0x11111111u, 0x10101111u, 0x0d0e0f0fu); }
        case 43u: { v = vec4<u32>(0x0a0b0c0cu, 0x07080809u, 0x05050606u, 0x03040405u); }
        case 44u: { v = vec4<u32>(0x0d0d0d0du, 0x0d0d0d0du, 0x0d0d0d0du, 0x0b0b0c0cu); }
        case 45u: { v = vec4<u32>(0x08090a0au, 0x06070708u, 0x04050506u, 0x03030404u); }
        case 46u: { v = vec4<u32>(0x09090909u, 0x0a0a0909u, 0x0a0a0a0au, 0x09090909u); }
        case 47u: { v = vec4<u32>(0x07070808u, 0x05050606u, 0x04040405u, 0x03030303u); }
        case 48u: { v = vec4<u32>(0x07070707u, 0x07070707u, 0x07070707u, 0x07070707u); }
        case 49u: { v = vec4<u32>(0x05060606u, 0x04040505u, 0x03030404u, 0x02020303u); }
        case 50u: { v = vec4<u32>(0x04040404u, 0x05050505u, 0x05050505u, 0x05050505u); }
        case 51u: { v = vec4<u32>(0x04040505u, 0x03040404u, 0x03030303u, 0x02020202u); }
        case 52u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 53u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x02020202u, 0x01020202u); }
        case 54u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 55u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x01010101u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02010101u); }
        case 57u: { v = vec4<u32>(0x02020202u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01010100u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x01010000u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 15u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd4e7f7ffu, 0x8a9badc1u, 0x55606c7au, 0x353b434bu); }
        case 1u: { v = vec4<u32>(0x23262b2fu, 0x181a1d1fu, 0x12131516u, 0x0e0f1011u); }
        case 2u: { v = vec4<u32>(0xd6e8f2fdu, 0x8a9baec2u, 0x55606d7bu, 0x353c434bu); }
        case 3u: { v = vec4<u32>(0x23262b2fu, 0x181a1d1fu, 0x12131516u, 0x0e0f1011u); }
        case 4u: { v = vec4<u32>(0xd7e5f4f9u, 0x8b9db0c4u, 0x55616d7cu, 0x353c434cu); }
        case 5u: { v = vec4<u32>(0x22262a2fu, 0x181a1c1fu, 0x12131416u, 0x0e0f1011u); }
        case 6u: { v = vec4<u32>(0xd5e4f0f1u, 0x8d9eb1c4u, 0x56616e7cu, 0x353c434cu); }
        case 7u: { v = vec4<u32>(0x22262a2fu, 0x181a1c1fu, 0x12131416u, 0x0e0f1011u); }
        case 8u: { v = vec4<u32>(0xd2e0e6e7u, 0x8d9eb0c1u, 0x56616e7du, 0x353c434cu); }
        case 9u: { v = vec4<u32>(0x22262a2fu, 0x171a1c1fu, 0x11131416u, 0x0e0e0f10u); }
        case 10u: { v = vec4<u32>(0xccd6dadau, 0x8c9cadbdu, 0x56616e7cu, 0x353b434cu); }
        case 11u: { v = vec4<u32>(0x22262a2fu, 0x17191c1fu, 0x11121415u, 0x0d0e0f10u); }
        case 12u: { v = vec4<u32>(0xc3caccccu, 0x8a99a8b7u, 0x55606d7bu, 0x343b424bu); }
        case 13u: { v = vec4<u32>(0x2125292eu, 0x17191b1eu, 0x11121315u, 0x0d0e0f0fu); }
        case 14u: { v = vec4<u32>(0xb7bbbcbdu, 0x8593a1aeu, 0x545f6b78u, 0x333a414au); }
        case 15u: { v = vec4<u32>(0x2125292eu, 0x16181b1eu, 0x10111314u, 0x0c0d0e0fu); }
        case 16u: { v = vec4<u32>(0xa8abacacu, 0x808c98a2u, 0x525c6773u, 0x32394048u); }
        case 17u: { v = vec4<u32>(0x2024282du, 0x16181a1du, 0x10111214u, 0x0c0d0d0eu); }
        case 18u: { v = vec4<u32>(0x999b9c9cu, 0x79838d94u, 0x4f58626du, 0x31373e46u); }
        case 19u: { v = vec4<u32>(0x1f23272bu, 0x1517191cu, 0x0f101213u, 0x0b0c0d0eu); }
        case 20u: { v = vec4<u32>(0x898b8b8bu, 0x70798186u, 0x4b545d67u, 0x2f353b43u); }
        case 21u: { v = vec4<u32>(0x1e21252au, 0x1416181bu, 0x0e0f1112u, 0x0b0b0c0du); }
        case 22u: { v = vec4<u32>(0x7a7b7b7bu, 0x676e7377u, 0x464e565fu, 0x2d32383fu); }
        case 23u: { v = vec4<u32>(0x1d202428u, 0x1315171au, 0x0d0f1011u, 0x0a0b0c0cu); }
        case 24u: { v = vec4<u32>(0x6a6b6b6bu, 0x5d626669u, 0x41484f56u, 0x2a2f353bu); }
        case 25u: { v = vec4<u32>(0x1b1e2226u, 0x12141618u, 0x0d0e0f11u, 0x090a0b0cu); }
        case 26u: { v = vec4<u32>(0x5c5d5d5du, 0x5256595bu, 0x3c42484du, 0x272c3136u); }
        case 27u: { v = vec4<u32>(0x1a1c2023u, 0x11131517u, 0x0c0d0e0fu, 0x09090a0bu); }
        case 28u: { v = vec4<u32>(0x4f4f4f4fu, 0x484b4d4eu, 0x363b4044u, 0x24282d31u); }
        case 29u: { v = vec4<u32>(0x181a1d21u, 0x10121315u, 0x0b0c0d0eu, 0x0809090au); }
        case 30u: { v = vec4<u32>(0x43434343u, 0x3e404142u, 0x3034383bu, 0x2125282cu); }
        case 31u: { v = vec4<u32>(0x16181b1eu, 0x0f101214u, 0x0a0b0c0du, 0x07080909u); }
        case 32u: { v = vec4<u32>(0x38383838u, 0x34363737u, 0x2a2d3033u, 0x1e212427u); }
        case 33u: { v = vec4<u32>(0x1416181bu, 0x0d0f1012u, 0x090a0b0cu, 0x07070809u); }
        case 34u: { v = vec4<u32>(0x2e2e2e2eu, 0x2c2d2d2eu, 0x2427292bu, 0x1a1d1f22u); }
        case 35u: { v = vec4<u32>(0x12141618u, 0x0c0d0f10u, 0x08090a0bu, 0x06060708u); }
        case 36u: { v = vec4<u32>(0x25252525u, 0x24252525u, 0x1f212223u, 0x17191b1du); }
        case 37u: { v = vec4<u32>(0x10121315u, 0x0b0c0d0fu, 0x0808090au, 0x05060607u); }
        case 38u: { v = vec4<u32>(0x1e1e1e1eu, 0x1d1e1e1eu, 0x1a1b1c1du, 0x14151718u); }
        case 39u: { v = vec4<u32>(0x0e0f1112u, 0x0a0b0c0du, 0x07070809u, 0x05050606u); }
        case 40u: { v = vec4<u32>(0x18181818u, 0x17171818u, 0x15161717u, 0x11121314u); }
        case 41u: { v = vec4<u32>(0x0c0d0e10u, 0x09090a0bu, 0x06070708u, 0x04050505u); }
        case 42u: { v = vec4<u32>(0x12121212u, 0x12121212u, 0x11111212u, 0x0e0f1010u); }
        case 43u: { v = vec4<u32>(0x0a0b0c0du, 0x0708090au, 0x05060607u, 0x04040405u); }
        case 44u: { v = vec4<u32>(0x0e0e0e0eu, 0x0e0e0e0eu, 0x0d0e0e0eu, 0x0b0c0c0du); }
        case 45u: { v = vec4<u32>(0x09090a0bu, 0x06070808u, 0x05050506u, 0x03030404u); }
        case 46u: { v = vec4<u32>(0x0a0a0a0au, 0x0a0a0a0au, 0x0a0a0a0au, 0x09090a0au); }
        case 47u: { v = vec4<u32>(0x07080809u, 0x05060607u, 0x04040505u, 0x03030304u); }
        case 48u: { v = vec4<u32>(0x07070707u, 0x07070707u, 0x08080707u, 0x07070707u); }
        case 49u: { v = vec4<u32>(0x06060607u, 0x04050505u, 0x03040404u, 0x02030303u); }
        case 50u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x05050505u, 0x05050505u); }
        case 51u: { v = vec4<u32>(0x05050505u, 0x04040404u, 0x03030303u, 0x02020202u); }
        case 52u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x04040303u, 0x04040404u); }
        case 53u: { v = vec4<u32>(0x03040404u, 0x03030303u, 0x02020303u, 0x02020202u); }
        case 54u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x03030202u); }
        case 55u: { v = vec4<u32>(0x03030303u, 0x02020202u, 0x02020202u, 0x01010202u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02020201u); }
        case 57u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01010102u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01010101u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 16u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd4e7f7ffu, 0x8a9badc0u, 0x55606c7au, 0x353c434cu); }
        case 1u: { v = vec4<u32>(0x23272b30u, 0x181a1d20u, 0x12131516u, 0x0f0f1011u); }
        case 2u: { v = vec4<u32>(0xd6e8f2fdu, 0x8a9baec2u, 0x55606d7bu, 0x353c434cu); }
        case 3u: { v = vec4<u32>(0x23272b30u, 0x181a1d20u, 0x12131516u, 0x0f0f1011u); }
        case 4u: { v = vec4<u32>(0xd6e5f4f9u, 0x8b9db0c4u, 0x56616d7bu, 0x353c434cu); }
        case 5u: { v = vec4<u32>(0x23262b30u, 0x181a1d20u, 0x12131516u, 0x0e0f1011u); }
        case 6u: { v = vec4<u32>(0xd4e4f0f1u, 0x8d9eb1c3u, 0x56616e7cu, 0x353c434cu); }
        case 7u: { v = vec4<u32>(0x23262b30u, 0x181a1d1fu, 0x12131516u, 0x0e0f1011u); }
        case 8u: { v = vec4<u32>(0xd1e0e6e7u, 0x8d9eb0c1u, 0x56616e7du, 0x353c434cu); }
        case 9u: { v = vec4<u32>(0x22262a2fu, 0x181a1c1fu, 0x12131416u, 0x0e0f1010u); }
        case 10u: { v = vec4<u32>(0xccd6dadau, 0x8c9cadbdu, 0x56616e7cu, 0x353c434cu); }
        case 11u: { v = vec4<u32>(0x22262a2fu, 0x171a1c1fu, 0x11131416u, 0x0e0e0f10u); }
        case 12u: { v = vec4<u32>(0xc3c9ccccu, 0x8999a8b7u, 0x55606d7bu, 0x343b434bu); }
        case 13u: { v = vec4<u32>(0x22252a2fu, 0x17191c1eu, 0x11121415u, 0x0d0e0f10u); }
        case 14u: { v = vec4<u32>(0xb6bbbcbcu, 0x8593a1adu, 0x545f6b78u, 0x343a424au); }
        case 15u: { v = vec4<u32>(0x2125292eu, 0x17191b1eu, 0x10121315u, 0x0d0d0e0fu); }
        case 16u: { v = vec4<u32>(0xa8abacacu, 0x808c98a2u, 0x525c6773u, 0x33394048u); }
        case 17u: { v = vec4<u32>(0x2024282du, 0x16181a1du, 0x10111214u, 0x0c0d0e0fu); }
        case 18u: { v = vec4<u32>(0x999b9b9bu, 0x79838d94u, 0x4f58636du, 0x31373e46u); }
        case 19u: { v = vec4<u32>(0x1f23272cu, 0x15171a1cu, 0x0f101213u, 0x0b0c0d0eu); }
        case 20u: { v = vec4<u32>(0x898a8b8bu, 0x70798086u, 0x4b545d67u, 0x2f353c43u); }
        case 21u: { v = vec4<u32>(0x1e22262au, 0x1416191bu, 0x0e101113u, 0x0b0c0c0du); }
        case 22u: { v = vec4<u32>(0x797a7b7bu, 0x676e7377u, 0x474e575fu, 0x2d32393fu); }
        case 23u: { v = vec4<u32>(0x1d202428u, 0x1315181au, 0x0e0f1012u, 0x0a0b0c0du); }
        case 24u: { v = vec4<u32>(0x6a6b6b6bu, 0x5d626669u, 0x42484f56u, 0x2b30353bu); }
        case 25u: { v = vec4<u32>(0x1b1f2226u, 0x12141619u, 0x0d0e0f11u, 0x0a0a0b0cu); }
        case 26u: { v = vec4<u32>(0x5c5d5d5du, 0x5256595bu, 0x3c42484du, 0x282c3136u); }
        case 27u: { v = vec4<u32>(0x1a1d2024u, 0x11131517u, 0x0c0d0e10u, 0x090a0a0bu); }
        case 28u: { v = vec4<u32>(0x4f505050u, 0x484b4d4eu, 0x363b4044u, 0x25292d32u); }
        case 29u: { v = vec4<u32>(0x181b1e21u, 0x10121416u, 0x0b0c0d0fu, 0x08090a0au); }
        case 30u: { v = vec4<u32>(0x43434343u, 0x3e404243u, 0x3134383bu, 0x2125292du); }
        case 31u: { v = vec4<u32>(0x16191b1eu, 0x0f101214u, 0x0a0b0c0eu, 0x0708090au); }
        case 32u: { v = vec4<u32>(0x38383838u, 0x35363738u, 0x2b2e3133u, 0x1e212427u); }
        case 33u: { v = vec4<u32>(0x1416191bu, 0x0e0f1112u, 0x0a0a0b0cu, 0x07070809u); }
        case 34u: { v = vec4<u32>(0x2f2f2f2fu, 0x2c2d2e2eu, 0x2527292bu, 0x1b1d2022u); }
        case 35u: { v = vec4<u32>(0x12141618u, 0x0c0e0f11u, 0x09090a0bu, 0x06070708u); }
        case 36u: { v = vec4<u32>(0x26262626u, 0x25252626u, 0x1f212324u, 0x17191c1eu); }
        case 37u: { v = vec4<u32>(0x10121416u, 0x0b0c0e0fu, 0x0809090au, 0x05060707u); }
        case 38u: { v = vec4<u32>(0x1f1f1f1fu, 0x1e1e1e1fu, 0x1a1c1d1du, 0x14161719u); }
        case 39u: { v = vec4<u32>(0x0e101113u, 0x0a0b0c0du, 0x07080809u, 0x05050606u); }
        case 40u: { v = vec4<u32>(0x18181818u, 0x18181818u, 0x16161718u, 0x11121415u); }
        case 41u: { v = vec4<u32>(0x0d0e0f10u, 0x090a0b0cu, 0x06070708u, 0x04050506u); }
        case 42u: { v = vec4<u32>(0x13131313u, 0x13131313u, 0x11121213u, 0x0e0f1011u); }
        case 43u: { v = vec4<u32>(0x0b0c0d0du, 0x0808090au, 0x05060607u, 0x04040505u); }
        case 44u: { v = vec4<u32>(0x0e0e0e0eu, 0x0e0e0e0eu, 0x0e0e0e0eu, 0x0c0c0d0du); }
        case 45u: { v = vec4<u32>(0x090a0a0bu, 0x07070808u, 0x05050606u, 0x03040404u); }
        case 46u: { v = vec4<u32>(0x0b0b0b0bu, 0x0b0b0b0bu, 0x0b0b0b0bu, 0x090a0a0au); }
        case 47u: { v = vec4<u32>(0x07080809u, 0x06060607u, 0x04040505u, 0x03030304u); }
        case 48u: { v = vec4<u32>(0x08080808u, 0x08080808u, 0x08080808u, 0x07080808u); }
        case 49u: { v = vec4<u32>(0x06060707u, 0x05050506u, 0x03040404u, 0x02030303u); }
        case 50u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x06060605u, 0x05060606u); }
        case 51u: { v = vec4<u32>(0x05050505u, 0x04040405u, 0x03030304u, 0x02020203u); }
        case 52u: { v = vec4<u32>(0x03030303u, 0x04030303u, 0x04040404u, 0x04040404u); }
        case 53u: { v = vec4<u32>(0x04040404u, 0x03030303u, 0x02020303u, 0x02020202u); }
        case 54u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x03030303u); }
        case 55u: { v = vec4<u32>(0x03030303u, 0x02020303u, 0x02020202u, 0x01010202u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02020202u); }
        case 57u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01010202u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x01000000u, 0x01010101u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 17u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd3e6f7ffu, 0x899aacc0u, 0x545f6c79u, 0x353b434bu); }
        case 1u: { v = vec4<u32>(0x23262a2fu, 0x181a1d1fu, 0x12131516u, 0x0f0f1011u); }
        case 2u: { v = vec4<u32>(0xd5e8f2fdu, 0x899aadc1u, 0x555f6c7au, 0x353b434bu); }
        case 3u: { v = vec4<u32>(0x23262a2fu, 0x181a1d1fu, 0x12131516u, 0x0e0f1011u); }
        case 4u: { v = vec4<u32>(0xd6e5f4f8u, 0x8a9cafc3u, 0x55606c7bu, 0x353b434bu); }
        case 5u: { v = vec4<u32>(0x23262a2fu, 0x181a1d1fu, 0x12131516u, 0x0e0f1011u); }
        case 6u: { v = vec4<u32>(0xd4e4eff1u, 0x8c9db0c3u, 0x55606d7bu, 0x353b434bu); }
        case 7u: { v = vec4<u32>(0x22262a2fu, 0x181a1c1fu, 0x12131416u, 0x0e0f1011u); }
        case 8u: { v = vec4<u32>(0xd1dfe5e6u, 0x8c9dafc0u, 0x55616d7cu, 0x353b434bu); }
        case 9u: { v = vec4<u32>(0x22262a2fu, 0x181a1c1fu, 0x12131416u, 0x0e0f0f10u); }
        case 10u: { v = vec4<u32>(0xcbd5d9d9u, 0x8b9bacbcu, 0x55606d7bu, 0x343b434bu); }
        case 11u: { v = vec4<u32>(0x22262a2fu, 0x17191c1fu, 0x11121415u, 0x0d0e0f10u); }
        case 12u: { v = vec4<u32>(0xc2c8cbcbu, 0x8898a7b6u, 0x54606c7au, 0x343b424bu); }
        case 13u: { v = vec4<u32>(0x2125292eu, 0x17191b1eu, 0x11121315u, 0x0d0e0f10u); }
        case 14u: { v = vec4<u32>(0xb5b9bbbbu, 0x8492a0acu, 0x535e6a76u, 0x333a414au); }
        case 15u: { v = vec4<u32>(0x2125292eu, 0x16191b1eu, 0x10121315u, 0x0d0d0e0fu); }
        case 16u: { v = vec4<u32>(0xa6aaaaabu, 0x7e8b97a0u, 0x515b6672u, 0x32384048u); }
        case 17u: { v = vec4<u32>(0x2024282du, 0x16181a1du, 0x10111214u, 0x0c0d0e0fu); }
        case 18u: { v = vec4<u32>(0x97999a9au, 0x77828b93u, 0x4e57626cu, 0x31373e45u); }
        case 19u: { v = vec4<u32>(0x1f23272bu, 0x1517191cu, 0x0f101213u, 0x0b0c0d0eu); }
        case 20u: { v = vec4<u32>(0x87898989u, 0x6f787f84u, 0x4a535c65u, 0x2f353b42u); }
        case 21u: { v = vec4<u32>(0x1e21252au, 0x1416191bu, 0x0e101112u, 0x0b0c0c0du); }
        case 22u: { v = vec4<u32>(0x78797979u, 0x666d7276u, 0x464e565eu, 0x2d32383fu); }
        case 23u: { v = vec4<u32>(0x1d202428u, 0x1315171au, 0x0e0f1012u, 0x0a0b0c0du); }
        case 24u: { v = vec4<u32>(0x696a6a6au, 0x5c616568u, 0x41484f55u, 0x2a2f353au); }
        case 25u: { v = vec4<u32>(0x1b1e2226u, 0x12141619u, 0x0d0e0f11u, 0x090a0b0cu); }
        case 26u: { v = vec4<u32>(0x5b5c5c5cu, 0x5155585au, 0x3b41474du, 0x272c3136u); }
        case 27u: { v = vec4<u32>(0x1a1d2023u, 0x11131517u, 0x0c0d0e10u, 0x09090a0bu); }
        case 28u: { v = vec4<u32>(0x4e4f4f4fu, 0x474a4c4eu, 0x363b3f44u, 0x24282d31u); }
        case 29u: { v = vec4<u32>(0x181b1d21u, 0x10121416u, 0x0b0c0d0fu, 0x08090a0au); }
        case 30u: { v = vec4<u32>(0x42434343u, 0x3e404142u, 0x3034383bu, 0x2125282cu); }
        case 31u: { v = vec4<u32>(0x16181b1eu, 0x0f101214u, 0x0a0b0c0eu, 0x0708090au); }
        case 32u: { v = vec4<u32>(0x38383838u, 0x34363737u, 0x2a2d3033u, 0x1e212427u); }
        case 33u: { v = vec4<u32>(0x1416191bu, 0x0e0f1112u, 0x090a0b0cu, 0x07070809u); }
        case 34u: { v = vec4<u32>(0x2e2e2e2eu, 0x2c2d2e2eu, 0x2527292bu, 0x1b1d2022u); }
        case 35u: { v = vec4<u32>(0x12141618u, 0x0c0e0f11u, 0x09090a0bu, 0x06070708u); }
        case 36u: { v = vec4<u32>(0x26262626u, 0x24252526u, 0x1f212224u, 0x17191b1du); }
        case 37u: { v = vec4<u32>(0x10121415u, 0x0b0c0e0fu, 0x0809090au, 0x06060707u); }
        case 38u: { v = vec4<u32>(0x1f1f1f1fu, 0x1e1e1e1eu, 0x1a1b1c1du, 0x14161719u); }
        case 39u: { v = vec4<u32>(0x0e101113u, 0x0a0b0c0du, 0x07080809u, 0x05050606u); }
        case 40u: { v = vec4<u32>(0x18181818u, 0x18181818u, 0x16161718u, 0x11121415u); }
        case 41u: { v = vec4<u32>(0x0d0e0f10u, 0x090a0b0cu, 0x06070708u, 0x04050506u); }
        case 42u: { v = vec4<u32>(0x13131313u, 0x13131313u, 0x11121213u, 0x0e0f1011u); }
        case 43u: { v = vec4<u32>(0x0b0c0d0du, 0x0808090au, 0x05060607u, 0x04040505u); }
        case 44u: { v = vec4<u32>(0x0e0e0e0eu, 0x0e0e0e0eu, 0x0e0e0e0eu, 0x0c0c0d0du); }
        case 45u: { v = vec4<u32>(0x090a0a0bu, 0x07070808u, 0x05050606u, 0x03040404u); }
        case 46u: { v = vec4<u32>(0x0b0b0b0bu, 0x0b0b0b0bu, 0x0b0b0b0bu, 0x090a0a0au); }
        case 47u: { v = vec4<u32>(0x08080909u, 0x06060707u, 0x04040505u, 0x03030304u); }
        case 48u: { v = vec4<u32>(0x08080808u, 0x08080808u, 0x08080808u, 0x07080808u); }
        case 49u: { v = vec4<u32>(0x06060707u, 0x05050506u, 0x03040404u, 0x02030303u); }
        case 50u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x06060606u, 0x06060606u); }
        case 51u: { v = vec4<u32>(0x05050505u, 0x04040405u, 0x03030304u, 0x02020203u); }
        case 52u: { v = vec4<u32>(0x03030303u, 0x04040403u, 0x04040404u, 0x04040404u); }
        case 53u: { v = vec4<u32>(0x04040404u, 0x03030304u, 0x02020303u, 0x02020202u); }
        case 54u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x03020202u, 0x03030303u); }
        case 55u: { v = vec4<u32>(0x03030303u, 0x02020303u, 0x02020202u, 0x01010202u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02020202u); }
        case 57u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01020202u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x01010000u, 0x01010101u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x01000000u); }
        case 61u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 18u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd2e6f6ffu, 0x8798aabeu, 0x535d6a77u, 0x343a4149u); }
        case 1u: { v = vec4<u32>(0x2225292eu, 0x181a1c1fu, 0x12131416u, 0x0e0f1011u); }
        case 2u: { v = vec4<u32>(0xd4e7f1fdu, 0x8799abbfu, 0x535e6a78u, 0x343a4149u); }
        case 3u: { v = vec4<u32>(0x2225292eu, 0x181a1c1fu, 0x12131416u, 0x0e0f1011u); }
        case 4u: { v = vec4<u32>(0xd5e4f4f8u, 0x889aadc1u, 0x535e6a79u, 0x343a414au); }
        case 5u: { v = vec4<u32>(0x2225292eu, 0x171a1c1fu, 0x12131416u, 0x0e0f1010u); }
        case 6u: { v = vec4<u32>(0xd3e3eff0u, 0x8a9baec1u, 0x535f6b79u, 0x343a414au); }
        case 7u: { v = vec4<u32>(0x2225292eu, 0x17191c1eu, 0x11131415u, 0x0e0f0f10u); }
        case 8u: { v = vec4<u32>(0xcfdee4e5u, 0x8a9badbfu, 0x545f6c7au, 0x333a414au); }
        case 9u: { v = vec4<u32>(0x2125292eu, 0x17191b1eu, 0x11121415u, 0x0e0e0f10u); }
        case 10u: { v = vec4<u32>(0xc9d4d7d8u, 0x8999aabau, 0x535f6b79u, 0x333a414au); }
        case 11u: { v = vec4<u32>(0x2125292eu, 0x17191b1eu, 0x11121315u, 0x0d0e0f10u); }
        case 12u: { v = vec4<u32>(0xc0c6c9c9u, 0x8695a5b4u, 0x535e6a78u, 0x33394149u); }
        case 13u: { v = vec4<u32>(0x2124282du, 0x16181b1du, 0x10121315u, 0x0d0d0e0fu); }
        case 14u: { v = vec4<u32>(0xb3b7b9b9u, 0x82909eaau, 0x515c6874u, 0x32384048u); }
        case 15u: { v = vec4<u32>(0x2024282du, 0x16181a1du, 0x10111214u, 0x0c0d0e0fu); }
        case 16u: { v = vec4<u32>(0xa4a7a8a8u, 0x7c88949eu, 0x4f596470u, 0x31373e46u); }
        case 17u: { v = vec4<u32>(0x1f23272cu, 0x15171a1cu, 0x0f111213u, 0x0c0c0d0eu); }
        case 18u: { v = vec4<u32>(0x94969797u, 0x757f8990u, 0x4c555f6au, 0x2f353c44u); }
        case 19u: { v = vec4<u32>(0x1e22262au, 0x1517191bu, 0x0f101113u, 0x0b0c0d0eu); }
        case 20u: { v = vec4<u32>(0x85868686u, 0x6c757c82u, 0x48515a63u, 0x2e333a41u); }
        case 21u: { v = vec4<u32>(0x1d212429u, 0x1416181au, 0x0e0f1112u, 0x0b0b0c0du); }
        case 22u: { v = vec4<u32>(0x75767676u, 0x636a6f73u, 0x444c535bu, 0x2b31373du); }
        case 23u: { v = vec4<u32>(0x1c1f2327u, 0x13151719u, 0x0d0e1011u, 0x0a0b0b0cu); }
        case 24u: { v = vec4<u32>(0x67676767u, 0x595e6265u, 0x3f464c53u, 0x292e3339u); }
        case 25u: { v = vec4<u32>(0x1b1e2125u, 0x12141618u, 0x0d0e0f10u, 0x090a0b0cu); }
        case 26u: { v = vec4<u32>(0x59595959u, 0x4f535658u, 0x3a3f454au, 0x262b2f34u); }
        case 27u: { v = vec4<u32>(0x191c1f22u, 0x11121417u, 0x0c0d0e0fu, 0x09090a0bu); }
        case 28u: { v = vec4<u32>(0x4c4c4c4cu, 0x45484a4bu, 0x34393d42u, 0x23272b30u); }
        case 29u: { v = vec4<u32>(0x171a1d20u, 0x10111315u, 0x0b0c0d0eu, 0x0809090au); }
        case 30u: { v = vec4<u32>(0x40414141u, 0x3c3e3f40u, 0x2f323639u, 0x2024272bu); }
        case 31u: { v = vec4<u32>(0x15181a1du, 0x0f101213u, 0x0a0b0c0du, 0x07080909u); }
        case 32u: { v = vec4<u32>(0x36363636u, 0x33343536u, 0x292c2f31u, 0x1d202326u); }
        case 33u: { v = vec4<u32>(0x1416181au, 0x0d0f1012u, 0x090a0b0cu, 0x07070808u); }
        case 34u: { v = vec4<u32>(0x2d2d2d2du, 0x2b2c2c2du, 0x24262829u, 0x1a1c1f21u); }
        case 35u: { v = vec4<u32>(0x12141518u, 0x0c0d0f10u, 0x08090a0bu, 0x06060708u); }
        case 36u: { v = vec4<u32>(0x25252525u, 0x23242425u, 0x1e202123u, 0x17191b1du); }
        case 37u: { v = vec4<u32>(0x10111315u, 0x0b0c0d0eu, 0x0808090au, 0x05060607u); }
        case 38u: { v = vec4<u32>(0x1e1e1e1eu, 0x1d1d1d1eu, 0x191b1c1cu, 0x14151718u); }
        case 39u: { v = vec4<u32>(0x0e0f1112u, 0x0a0b0c0du, 0x07070809u, 0x05050606u); }
        case 40u: { v = vec4<u32>(0x18181818u, 0x17171718u, 0x15161617u, 0x11121314u); }
        case 41u: { v = vec4<u32>(0x0c0d0e10u, 0x09090a0bu, 0x06070708u, 0x04050506u); }
        case 42u: { v = vec4<u32>(0x12121212u, 0x12121212u, 0x11111212u, 0x0e0f1010u); }
        case 43u: { v = vec4<u32>(0x0a0b0c0du, 0x0808090au, 0x05060607u, 0x04040405u); }
        case 44u: { v = vec4<u32>(0x0e0e0e0eu, 0x0e0e0e0eu, 0x0d0e0e0eu, 0x0c0c0d0du); }
        case 45u: { v = vec4<u32>(0x090a0a0bu, 0x06070808u, 0x05050506u, 0x03040404u); }
        case 46u: { v = vec4<u32>(0x0a0a0a0au, 0x0b0b0b0au, 0x0a0b0b0bu, 0x090a0a0au); }
        case 47u: { v = vec4<u32>(0x07080809u, 0x05060607u, 0x04040505u, 0x03030304u); }
        case 48u: { v = vec4<u32>(0x08080808u, 0x08080808u, 0x08080808u, 0x07070808u); }
        case 49u: { v = vec4<u32>(0x06060707u, 0x05050506u, 0x03040404u, 0x02030303u); }
        case 50u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x06060605u, 0x05060606u); }
        case 51u: { v = vec4<u32>(0x05050505u, 0x04040404u, 0x03030303u, 0x02020203u); }
        case 52u: { v = vec4<u32>(0x03030303u, 0x04040303u, 0x04040404u, 0x04040404u); }
        case 53u: { v = vec4<u32>(0x04040404u, 0x03030303u, 0x02020303u, 0x02020202u); }
        case 54u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x03020202u, 0x03030303u); }
        case 55u: { v = vec4<u32>(0x03030303u, 0x02020303u, 0x02020202u, 0x01010202u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02020202u); }
        case 57u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01010202u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x01010000u, 0x01010101u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 19u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xd0e5f6ffu, 0x8495a8bcu, 0x505b6774u, 0x31383f47u); }
        case 1u: { v = vec4<u32>(0x2024282cu, 0x16181b1du, 0x11121315u, 0x0d0e0f10u); }
        case 2u: { v = vec4<u32>(0xd2e6f1fdu, 0x8496a9bdu, 0x505b6775u, 0x32383f47u); }
        case 3u: { v = vec4<u32>(0x2024282cu, 0x16181b1du, 0x11121315u, 0x0d0e0f10u); }
        case 4u: { v = vec4<u32>(0xd3e3f3f8u, 0x8597aabfu, 0x505b6775u, 0x32383f47u); }
        case 5u: { v = vec4<u32>(0x2024282cu, 0x16181b1du, 0x11121315u, 0x0d0e0f10u); }
        case 6u: { v = vec4<u32>(0xd1e2eeefu, 0x8698abbfu, 0x515c6876u, 0x31383f47u); }
        case 7u: { v = vec4<u32>(0x2023272cu, 0x16181a1du, 0x10121314u, 0x0d0e0f0fu); }
        case 8u: { v = vec4<u32>(0xcddce3e3u, 0x8798aabcu, 0x515c6877u, 0x31383f47u); }
        case 9u: { v = vec4<u32>(0x2023272cu, 0x16181a1du, 0x10111314u, 0x0d0e0e0fu); }
        case 10u: { v = vec4<u32>(0xc7d2d5d6u, 0x8696a7b8u, 0x505c6876u, 0x31373f47u); }
        case 11u: { v = vec4<u32>(0x2023272cu, 0x16181a1du, 0x10111214u, 0x0c0d0e0fu); }
        case 12u: { v = vec4<u32>(0xbdc4c6c6u, 0x8392a2b0u, 0x505b6774u, 0x31373e46u); }
        case 13u: { v = vec4<u32>(0x1f23272bu, 0x1517191cu, 0x10111214u, 0x0c0d0e0fu); }
        case 14u: { v = vec4<u32>(0xafb4b5b5u, 0x7e8c9aa6u, 0x4e596471u, 0x30363d45u); }
        case 15u: { v = vec4<u32>(0x1f22262bu, 0x1517191cu, 0x0f101213u, 0x0c0c0d0eu); }
        case 16u: { v = vec4<u32>(0xa0a3a4a4u, 0x7885909au, 0x4c56616cu, 0x2f353c43u); }
        case 17u: { v = vec4<u32>(0x1e21252au, 0x1416181bu, 0x0f101112u, 0x0b0c0d0eu); }
        case 18u: { v = vec4<u32>(0x90929393u, 0x717c858cu, 0x49525c66u, 0x2d333a41u); }
        case 19u: { v = vec4<u32>(0x1d202428u, 0x1315181au, 0x0e0f1012u, 0x0b0b0c0du); }
        case 20u: { v = vec4<u32>(0x80828282u, 0x6971787du, 0x454e565fu, 0x2c31373eu); }
        case 21u: { v = vec4<u32>(0x1c1f2327u, 0x13151719u, 0x0d0e1011u, 0x0a0b0b0cu); }
        case 22u: { v = vec4<u32>(0x71727272u, 0x5f666b6fu, 0x41485058u, 0x292e343au); }
        case 23u: { v = vec4<u32>(0x1b1e2125u, 0x12141618u, 0x0d0e0f10u, 0x090a0b0cu); }
        case 24u: { v = vec4<u32>(0x62636363u, 0x555a5e61u, 0x3c43494fu, 0x272c3136u); }
        case 25u: { v = vec4<u32>(0x191c1f23u, 0x11131517u, 0x0c0d0e0fu, 0x09090a0bu); }
        case 26u: { v = vec4<u32>(0x55555555u, 0x4b4f5254u, 0x373c4247u, 0x24282d32u); }
        case 27u: { v = vec4<u32>(0x181a1d21u, 0x10111315u, 0x0b0c0d0eu, 0x0809090au); }
        case 28u: { v = vec4<u32>(0x48484849u, 0x42444648u, 0x32363a3eu, 0x2125292du); }
        case 29u: { v = vec4<u32>(0x16181b1eu, 0x0f101214u, 0x0a0b0c0du, 0x07080909u); }
        case 30u: { v = vec4<u32>(0x3d3d3d3du, 0x393a3c3du, 0x2c303336u, 0x1e222529u); }
        case 31u: { v = vec4<u32>(0x1416191cu, 0x0e0f1112u, 0x0a0a0b0cu, 0x07070809u); }
        case 32u: { v = vec4<u32>(0x33333333u, 0x30313233u, 0x272a2c2eu, 0x1b1e2124u); }
        case 33u: { v = vec4<u32>(0x13141719u, 0x0d0e0f11u, 0x090a0a0bu, 0x06070708u); }
        case 34u: { v = vec4<u32>(0x2a2a2a2au, 0x28292a2au, 0x22242527u, 0x181b1d1fu); }
        case 35u: { v = vec4<u32>(0x11121416u, 0x0b0d0e0fu, 0x0809090au, 0x06060707u); }
        case 36u: { v = vec4<u32>(0x22222222u, 0x21222222u, 0x1d1e1f20u, 0x1517191bu); }
        case 37u: { v = vec4<u32>(0x0f101214u, 0x0a0b0c0eu, 0x07080909u, 0x05060607u); }
        case 38u: { v = vec4<u32>(0x1c1c1c1cu, 0x1b1b1c1cu, 0x18191a1bu, 0x12141517u); }
        case 39u: { v = vec4<u32>(0x0d0e1011u, 0x090a0b0cu, 0x06070808u, 0x05050506u); }
        case 40u: { v = vec4<u32>(0x16161616u, 0x16161616u, 0x14141515u, 0x10111213u); }
        case 41u: { v = vec4<u32>(0x0b0d0e0fu, 0x08090a0bu, 0x06060707u, 0x04040505u); }
        case 42u: { v = vec4<u32>(0x11111111u, 0x11111111u, 0x10101111u, 0x0d0e0f0fu); }
        case 43u: { v = vec4<u32>(0x0a0b0c0cu, 0x07080809u, 0x05050606u, 0x04040405u); }
        case 44u: { v = vec4<u32>(0x0d0d0d0du, 0x0d0d0d0du, 0x0d0d0d0du, 0x0b0b0c0cu); }
        case 45u: { v = vec4<u32>(0x08090a0au, 0x06070708u, 0x04050506u, 0x03030404u); }
        case 46u: { v = vec4<u32>(0x0a0a0a0au, 0x0a0a0a0au, 0x0a0a0a0au, 0x0909090au); }
        case 47u: { v = vec4<u32>(0x07070808u, 0x05060606u, 0x04040405u, 0x03030303u); }
        case 48u: { v = vec4<u32>(0x07070707u, 0x07070707u, 0x07070707u, 0x07070707u); }
        case 49u: { v = vec4<u32>(0x06060607u, 0x04050505u, 0x03030404u, 0x02020303u); }
        case 50u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x05050505u, 0x05050505u); }
        case 51u: { v = vec4<u32>(0x04050505u, 0x04040404u, 0x03030303u, 0x02020202u); }
        case 52u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x04040403u, 0x04040404u); }
        case 53u: { v = vec4<u32>(0x03040404u, 0x03030303u, 0x02020203u, 0x02020202u); }
        case 54u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x03030302u); }
        case 55u: { v = vec4<u32>(0x03030303u, 0x02020202u, 0x02020202u, 0x01010102u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02020201u); }
        case 57u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01010102u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x01000000u, 0x01010101u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 20u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xcee3f5ffu, 0x7f91a4b8u, 0x4c566270u, 0x2e343b43u); }
        case 1u: { v = vec4<u32>(0x1e212529u, 0x1517191bu, 0x0f111213u, 0x0c0d0e0fu); }
        case 2u: { v = vec4<u32>(0xd0e5f1fdu, 0x8091a5bau, 0x4c566270u, 0x2e343b43u); }
        case 3u: { v = vec4<u32>(0x1e212529u, 0x1517191bu, 0x0f101213u, 0x0c0d0e0eu); }
        case 4u: { v = vec4<u32>(0xd1e2f2f7u, 0x8193a7bcu, 0x4c576371u, 0x2e343b43u); }
        case 5u: { v = vec4<u32>(0x1e212529u, 0x1516191bu, 0x0f101213u, 0x0c0d0e0eu); }
        case 6u: { v = vec4<u32>(0xcee0eceeu, 0x8294a8bcu, 0x4c576472u, 0x2e343b43u); }
        case 7u: { v = vec4<u32>(0x1e212529u, 0x1416181bu, 0x0f101113u, 0x0c0d0d0eu); }
        case 8u: { v = vec4<u32>(0xcbdae1e1u, 0x8294a6b9u, 0x4d576472u, 0x2e343b43u); }
        case 9u: { v = vec4<u32>(0x1e212529u, 0x1416181bu, 0x0f101113u, 0x0c0c0d0eu); }
        case 10u: { v = vec4<u32>(0xc4ced2d3u, 0x8191a3b4u, 0x4c576371u, 0x2e343b43u); }
        case 11u: { v = vec4<u32>(0x1d212429u, 0x1416181au, 0x0f101112u, 0x0b0c0d0eu); }
        case 12u: { v = vec4<u32>(0xb8c0c2c2u, 0x7e8d9dacu, 0x4b56626fu, 0x2d333a42u); }
        case 13u: { v = vec4<u32>(0x1d202428u, 0x1415181au, 0x0e0f1112u, 0x0b0c0c0du); }
        case 14u: { v = vec4<u32>(0xaaafb0b0u, 0x798795a1u, 0x4a545f6cu, 0x2d323941u); }
        case 15u: { v = vec4<u32>(0x1c202328u, 0x13151719u, 0x0e0f1012u, 0x0b0b0c0du); }
        case 16u: { v = vec4<u32>(0x9b9e9f9fu, 0x737f8b94u, 0x48515c67u, 0x2c31383fu); }
        case 17u: { v = vec4<u32>(0x1c1f2227u, 0x13141619u, 0x0d0e1011u, 0x0a0b0c0cu); }
        case 18u: { v = vec4<u32>(0x8a8c8d8du, 0x6c767f86u, 0x454d5761u, 0x2a30363du); }
        case 19u: { v = vec4<u32>(0x1b1e2125u, 0x12141618u, 0x0d0e0f10u, 0x0a0a0b0cu); }
        case 20u: { v = vec4<u32>(0x7a7b7c7cu, 0x636b7277u, 0x4149515au, 0x282d333au); }
        case 21u: { v = vec4<u32>(0x1a1d2024u, 0x11131517u, 0x0c0d0e10u, 0x090a0a0bu); }
        case 22u: { v = vec4<u32>(0x6b6b6c6cu, 0x5a606569u, 0x3d444b52u, 0x262b3036u); }
        case 23u: { v = vec4<u32>(0x181b1e22u, 0x10121416u, 0x0c0d0e0fu, 0x09090a0bu); }
        case 24u: { v = vec4<u32>(0x5c5d5d5du, 0x5055585bu, 0x383e444au, 0x24282d32u); }
        case 25u: { v = vec4<u32>(0x171a1d20u, 0x0f111315u, 0x0b0c0d0eu, 0x0809090au); }
        case 26u: { v = vec4<u32>(0x4f4f4f4fu, 0x464a4c4eu, 0x33383d42u, 0x2125292eu); }
        case 27u: { v = vec4<u32>(0x16181b1eu, 0x0e101214u, 0x0a0b0c0du, 0x07080909u); }
        case 28u: { v = vec4<u32>(0x43434343u, 0x3d3f4142u, 0x2e32363au, 0x1f22262au); }
        case 29u: { v = vec4<u32>(0x1416191cu, 0x0d0f1012u, 0x090a0b0cu, 0x07070809u); }
        case 30u: { v = vec4<u32>(0x38383838u, 0x34363738u, 0x292c2f32u, 0x1c1f2225u); }
        case 31u: { v = vec4<u32>(0x13151719u, 0x0c0e0f11u, 0x09090a0bu, 0x06070708u); }
        case 32u: { v = vec4<u32>(0x2e2f2f2fu, 0x2c2d2e2eu, 0x2326282au, 0x191b1e21u); }
        case 33u: { v = vec4<u32>(0x11131517u, 0x0b0d0e0fu, 0x0809090au, 0x06060707u); }
        case 34u: { v = vec4<u32>(0x26262626u, 0x25252626u, 0x1e202223u, 0x16181a1cu); }
        case 35u: { v = vec4<u32>(0x0f111214u, 0x0a0b0d0eu, 0x07080909u, 0x05060607u); }
        case 36u: { v = vec4<u32>(0x1f1f1f1fu, 0x1e1f1f1fu, 0x1a1b1c1du, 0x13151718u); }
        case 37u: { v = vec4<u32>(0x0e0f1012u, 0x090a0b0cu, 0x06070808u, 0x05050506u); }
        case 38u: { v = vec4<u32>(0x19191919u, 0x18191919u, 0x16171718u, 0x11121314u); }
        case 39u: { v = vec4<u32>(0x0c0d0e0fu, 0x08090a0bu, 0x06060708u, 0x04040505u); }
        case 40u: { v = vec4<u32>(0x14141414u, 0x13141414u, 0x12121313u, 0x0e0f1011u); }
        case 41u: { v = vec4<u32>(0x0a0b0c0du, 0x07080909u, 0x05060607u, 0x04040405u); }
        case 42u: { v = vec4<u32>(0x0f0f0f0fu, 0x0f0f0f0fu, 0x0e0f0f0fu, 0x0c0d0d0eu); }
        case 43u: { v = vec4<u32>(0x090a0a0bu, 0x06070808u, 0x04050506u, 0x03030404u); }
        case 44u: { v = vec4<u32>(0x0c0c0c0cu, 0x0c0c0c0cu, 0x0b0c0c0cu, 0x0a0a0b0bu); }
        case 45u: { v = vec4<u32>(0x07080909u, 0x05060607u, 0x04040505u, 0x03030304u); }
        case 46u: { v = vec4<u32>(0x09090909u, 0x09090909u, 0x09090909u, 0x08080809u); }
        case 47u: { v = vec4<u32>(0x06070707u, 0x05050506u, 0x03040404u, 0x02030303u); }
        case 48u: { v = vec4<u32>(0x06060606u, 0x06060606u, 0x07070707u, 0x06060606u); }
        case 49u: { v = vec4<u32>(0x05050606u, 0x04040405u, 0x03030304u, 0x02020203u); }
        case 50u: { v = vec4<u32>(0x04040404u, 0x05050404u, 0x05050505u, 0x05050505u); }
        case 51u: { v = vec4<u32>(0x04040404u, 0x03030404u, 0x02030303u, 0x02020202u); }
        case 52u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 53u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x02020202u, 0x01020202u); }
        case 54u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 55u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x01010101u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x02010101u); }
        case 57u: { v = vec4<u32>(0x02020202u, 0x01010202u, 0x01010101u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01010100u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x01010100u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 21u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xcae1f4ffu, 0x798b9fb4u, 0x46505c6au, 0x2a30363eu); }
        case 1u: { v = vec4<u32>(0x1b1e2125u, 0x12141618u, 0x0e0f1011u, 0x0b0b0c0du); }
        case 2u: { v = vec4<u32>(0xcce2f0fdu, 0x7a8c9fb5u, 0x46515c6au, 0x2a30363eu); }
        case 3u: { v = vec4<u32>(0x1b1e2125u, 0x12141618u, 0x0e0e1011u, 0x0b0b0c0du); }
        case 4u: { v = vec4<u32>(0xcde0f2f6u, 0x7b8da1b7u, 0x47515d6bu, 0x2a30363eu); }
        case 5u: { v = vec4<u32>(0x1b1e2125u, 0x12141618u, 0x0d0e0f11u, 0x0b0b0c0du); }
        case 6u: { v = vec4<u32>(0xcbdeeaecu, 0x7c8ea2b7u, 0x47515d6cu, 0x2a30363eu); }
        case 7u: { v = vec4<u32>(0x1b1e2125u, 0x12141618u, 0x0d0e0f11u, 0x0a0b0c0cu); }
        case 8u: { v = vec4<u32>(0xc7d7dedeu, 0x7c8ea1b4u, 0x47515e6cu, 0x2a2f363eu); }
        case 9u: { v = vec4<u32>(0x1a1d2125u, 0x12141518u, 0x0d0e0f10u, 0x0a0b0b0cu); }
        case 10u: { v = vec4<u32>(0xbfcaceceu, 0x7a8b9dafu, 0x46515d6bu, 0x2a2f363du); }
        case 11u: { v = vec4<u32>(0x1a1d2125u, 0x12131517u, 0x0d0e0f10u, 0x0a0b0b0cu); }
        case 12u: { v = vec4<u32>(0xb3babcbcu, 0x778797a6u, 0x46505b69u, 0x292f353du); }
        case 13u: { v = vec4<u32>(0x1a1d2024u, 0x11131517u, 0x0c0d0f10u, 0x0a0a0b0cu); }
        case 14u: { v = vec4<u32>(0xa4a8aaaau, 0x72808e9bu, 0x444e5965u, 0x282e343bu); }
        case 15u: { v = vec4<u32>(0x191c2024u, 0x11121417u, 0x0c0d0e0fu, 0x090a0a0bu); }
        case 16u: { v = vec4<u32>(0x93969797u, 0x6c78838du, 0x424b5560u, 0x272c333au); }
        case 17u: { v = vec4<u32>(0x181b1f23u, 0x10121416u, 0x0c0d0e0fu, 0x09090a0bu); }
        case 18u: { v = vec4<u32>(0x82848585u, 0x646e777eu, 0x3f47505au, 0x262b3137u); }
        case 19u: { v = vec4<u32>(0x181a1e21u, 0x10111315u, 0x0b0c0d0eu, 0x08090a0au); }
        case 20u: { v = vec4<u32>(0x72737373u, 0x5b636a6fu, 0x3b424a53u, 0x24292e34u); }
        case 21u: { v = vec4<u32>(0x17191c20u, 0x0f111214u, 0x0b0b0c0eu, 0x0808090au); }
        case 22u: { v = vec4<u32>(0x62636363u, 0x52585d60u, 0x373d444bu, 0x22262b31u); }
        case 23u: { v = vec4<u32>(0x16181b1eu, 0x0e101113u, 0x0a0b0c0du, 0x07080909u); }
        case 24u: { v = vec4<u32>(0x54545454u, 0x484d5052u, 0x32383d43u, 0x2024282du); }
        case 25u: { v = vec4<u32>(0x1417191cu, 0x0d0f1012u, 0x090a0b0cu, 0x07070809u); }
        case 26u: { v = vec4<u32>(0x47474747u, 0x3f424446u, 0x2d32373bu, 0x1d212529u); }
        case 27u: { v = vec4<u32>(0x1315181au, 0x0d0e0f11u, 0x09090a0bu, 0x06070708u); }
        case 28u: { v = vec4<u32>(0x3b3b3b3bu, 0x36383a3bu, 0x282c3033u, 0x1b1e2125u); }
        case 29u: { v = vec4<u32>(0x11131618u, 0x0c0d0e10u, 0x08090a0bu, 0x06060707u); }
        case 30u: { v = vec4<u32>(0x31313131u, 0x2e2f3031u, 0x2326292cu, 0x181b1e20u); }
        case 31u: { v = vec4<u32>(0x10121416u, 0x0b0c0d0eu, 0x0708090au, 0x05060607u); }
        case 32u: { v = vec4<u32>(0x28282828u, 0x26272828u, 0x1f212325u, 0x16181a1cu); }
        case 33u: { v = vec4<u32>(0x0e101214u, 0x0a0b0c0du, 0x07070809u, 0x05050606u); }
        case 34u: { v = vec4<u32>(0x21212121u, 0x1f202021u, 0x1a1c1d1eu, 0x13151718u); }
        case 35u: { v = vec4<u32>(0x0d0e1011u, 0x090a0b0cu, 0x06070708u, 0x04050506u); }
        case 36u: { v = vec4<u32>(0x1a1a1a1au, 0x1a1a1a1au, 0x16171819u, 0x11121315u); }
        case 37u: { v = vec4<u32>(0x0c0d0e0fu, 0x08090a0au, 0x05060707u, 0x04040505u); }
        case 38u: { v = vec4<u32>(0x15151515u, 0x15151515u, 0x12131414u, 0x0e0f1011u); }
        case 39u: { v = vec4<u32>(0x0a0b0c0du, 0x07080809u, 0x05050606u, 0x03040404u); }
        case 40u: { v = vec4<u32>(0x11111111u, 0x10101111u, 0x0f0f1010u, 0x0c0d0e0eu); }
        case 41u: { v = vec4<u32>(0x09090a0bu, 0x06070708u, 0x04050506u, 0x03030404u); }
        case 42u: { v = vec4<u32>(0x0d0d0d0du, 0x0d0d0d0du, 0x0c0c0d0du, 0x0a0b0b0cu); }
        case 43u: { v = vec4<u32>(0x07080909u, 0x05060607u, 0x04040405u, 0x03030303u); }
        case 44u: { v = vec4<u32>(0x0a0a0a0au, 0x0a0a0a0au, 0x090a0a0au, 0x08080909u); }
        case 45u: { v = vec4<u32>(0x06070708u, 0x05050506u, 0x03040404u, 0x02020303u); }
        case 46u: { v = vec4<u32>(0x07070707u, 0x07070707u, 0x07070707u, 0x06070707u); }
        case 47u: { v = vec4<u32>(0x05060606u, 0x04040405u, 0x03030304u, 0x02020203u); }
        case 48u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x05050505u, 0x05050505u); }
        case 49u: { v = vec4<u32>(0x04040505u, 0x03030404u, 0x02030303u, 0x02020202u); }
        case 50u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04040404u, 0x04040404u); }
        case 51u: { v = vec4<u32>(0x03030404u, 0x03030303u, 0x02020202u, 0x01020202u); }
        case 52u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x03030303u, 0x03030303u); }
        case 53u: { v = vec4<u32>(0x03030303u, 0x02020202u, 0x02020202u, 0x01010101u); }
        case 54u: { v = vec4<u32>(0x01010101u, 0x02010101u, 0x02020202u, 0x02020202u); }
        case 55u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x01010102u, 0x01010101u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 57u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01000000u, 0x01010101u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x01010101u, 0x01010101u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 22u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xc6def3ffu, 0x718397aeu, 0x3f495462u, 0x24292f36u); }
        case 1u: { v = vec4<u32>(0x16191c20u, 0x0f111214u, 0x0b0c0d0eu, 0x09090a0au); }
        case 2u: { v = vec4<u32>(0xc8e0effcu, 0x728498afu, 0x3f495462u, 0x24292f37u); }
        case 3u: { v = vec4<u32>(0x16191c20u, 0x0f111214u, 0x0b0c0d0eu, 0x09090a0au); }
        case 4u: { v = vec4<u32>(0xc9ddf0f5u, 0x73859ab1u, 0x3f495563u, 0x24292f37u); }
        case 5u: { v = vec4<u32>(0x16191c20u, 0x0f101214u, 0x0b0c0d0eu, 0x09090a0au); }
        case 6u: { v = vec4<u32>(0xc6dae8e9u, 0x73869bb1u, 0x3f495563u, 0x24292f37u); }
        case 7u: { v = vec4<u32>(0x16191c20u, 0x0f101214u, 0x0b0c0d0eu, 0x0809090au); }
        case 8u: { v = vec4<u32>(0xc1d2d9dau, 0x738699aeu, 0x3f495563u, 0x24292f37u); }
        case 9u: { v = vec4<u32>(0x16191c20u, 0x0f101214u, 0x0b0b0c0du, 0x0809090au); }
        case 10u: { v = vec4<u32>(0xb8c4c8c8u, 0x728395a7u, 0x3f495562u, 0x24292f36u); }
        case 11u: { v = vec4<u32>(0x16181c1fu, 0x0e101214u, 0x0a0b0c0du, 0x0809090au); }
        case 12u: { v = vec4<u32>(0xabb2b5b5u, 0x6e7e8e9eu, 0x3e485360u, 0x23282e35u); }
        case 13u: { v = vec4<u32>(0x15181b1fu, 0x0e101113u, 0x0a0b0c0du, 0x08080909u); }
        case 14u: { v = vec4<u32>(0x9a9fa1a1u, 0x69778591u, 0x3c45505cu, 0x22272d34u); }
        case 15u: { v = vec4<u32>(0x15181b1eu, 0x0e0f1113u, 0x0a0b0b0du, 0x07080809u); }
        case 16u: { v = vec4<u32>(0x898c8d8du, 0x626e7983u, 0x3a424c57u, 0x21262c32u); }
        case 17u: { v = vec4<u32>(0x14171a1du, 0x0d0f1012u, 0x090a0b0cu, 0x07080809u); }
        case 18u: { v = vec4<u32>(0x7779797au, 0x5a646c73u, 0x373e4750u, 0x20242a30u); }
        case 19u: { v = vec4<u32>(0x1416191cu, 0x0d0e1011u, 0x090a0b0cu, 0x07070808u); }
        case 20u: { v = vec4<u32>(0x66676868u, 0x51595f63u, 0x333a4149u, 0x1e22272du); }
        case 21u: { v = vec4<u32>(0x1315181bu, 0x0c0d0f11u, 0x08090a0bu, 0x06070708u); }
        case 22u: { v = vec4<u32>(0x56575757u, 0x484d5255u, 0x2f353b41u, 0x1c202529u); }
        case 23u: { v = vec4<u32>(0x12141619u, 0x0b0d0e10u, 0x0809090au, 0x06060707u); }
        case 24u: { v = vec4<u32>(0x48494949u, 0x3e424547u, 0x2a2f343au, 0x1a1e2226u); }
        case 25u: { v = vec4<u32>(0x10121517u, 0x0b0c0d0fu, 0x0708090au, 0x05060607u); }
        case 26u: { v = vec4<u32>(0x3c3c3c3cu, 0x35383a3bu, 0x262a2e32u, 0x181b1e22u); }
        case 27u: { v = vec4<u32>(0x0f111315u, 0x0a0b0c0eu, 0x07070809u, 0x05050606u); }
        case 28u: { v = vec4<u32>(0x31313131u, 0x2d2f3031u, 0x2124282au, 0x16181b1eu); }
        case 29u: { v = vec4<u32>(0x0e101113u, 0x090a0b0du, 0x06070808u, 0x04050506u); }
        case 30u: { v = vec4<u32>(0x28282828u, 0x25262728u, 0x1d1f2124u, 0x1316181au); }
        case 31u: { v = vec4<u32>(0x0d0e1011u, 0x08090a0bu, 0x06060708u, 0x04040505u); }
        case 32u: { v = vec4<u32>(0x20202020u, 0x1e1f2020u, 0x191a1c1du, 0x11131517u); }
        case 33u: { v = vec4<u32>(0x0b0d0e0fu, 0x0808090au, 0x05060607u, 0x04040405u); }
        case 34u: { v = vec4<u32>(0x1a1a1a1au, 0x1919191au, 0x15161718u, 0x0f101213u); }
        case 35u: { v = vec4<u32>(0x0a0b0c0eu, 0x07070809u, 0x05050606u, 0x03040404u); }
        case 36u: { v = vec4<u32>(0x14141414u, 0x14141414u, 0x11121313u, 0x0d0e0f10u); }
        case 37u: { v = vec4<u32>(0x090a0b0cu, 0x06070708u, 0x04050505u, 0x03030304u); }
        case 38u: { v = vec4<u32>(0x10101010u, 0x10101010u, 0x0e0f0f0fu, 0x0b0c0c0du); }
        case 39u: { v = vec4<u32>(0x0808090au, 0x05060607u, 0x04040405u, 0x03030303u); }
        case 40u: { v = vec4<u32>(0x0c0c0c0cu, 0x0c0c0c0cu, 0x0b0c0c0cu, 0x090a0a0bu); }
        case 41u: { v = vec4<u32>(0x07070808u, 0x05050606u, 0x03030404u, 0x02020303u); }
        case 42u: { v = vec4<u32>(0x09090909u, 0x09090909u, 0x09090909u, 0x07080809u); }
        case 43u: { v = vec4<u32>(0x06060607u, 0x04040505u, 0x03030304u, 0x02020203u); }
        case 44u: { v = vec4<u32>(0x07070707u, 0x07070707u, 0x07070707u, 0x06060707u); }
        case 45u: { v = vec4<u32>(0x05050506u, 0x03040404u, 0x02030303u, 0x02020202u); }
        case 46u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x05050505u, 0x05050505u); }
        case 47u: { v = vec4<u32>(0x04040404u, 0x03030304u, 0x02020203u, 0x01020202u); }
        case 48u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04040404u, 0x04040404u); }
        case 49u: { v = vec4<u32>(0x03030303u, 0x02020303u, 0x02020202u, 0x01010102u); }
        case 50u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x03030303u); }
        case 51u: { v = vec4<u32>(0x02020303u, 0x02020202u, 0x01020202u, 0x01010101u); }
        case 52u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 53u: { v = vec4<u32>(0x02020202u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 54u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 55u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 56u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 57u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 23u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xbfdaf2ffu, 0x66788ea5u, 0x353e4957u, 0x1d21272du); }
        case 1u: { v = vec4<u32>(0x11131619u, 0x0b0c0d0fu, 0x0808090au, 0x06060707u); }
        case 2u: { v = vec4<u32>(0xc1dceefcu, 0x67798ea7u, 0x353e4a57u, 0x1d21272du); }
        case 3u: { v = vec4<u32>(0x11131619u, 0x0b0c0d0fu, 0x0808090au, 0x06060707u); }
        case 4u: { v = vec4<u32>(0xc3daeef3u, 0x677a90a9u, 0x353f4a57u, 0x1d21272du); }
        case 5u: { v = vec4<u32>(0x11131619u, 0x0b0c0d0fu, 0x0808090au, 0x06060707u); }
        case 6u: { v = vec4<u32>(0xc0d6e4e6u, 0x687b91a9u, 0x353f4a58u, 0x1d21272du); }
        case 7u: { v = vec4<u32>(0x11131619u, 0x0b0c0d0fu, 0x0808090au, 0x06060707u); }
        case 8u: { v = vec4<u32>(0xbaccd3d4u, 0x687a8fa5u, 0x353f4a58u, 0x1c21272du); }
        case 9u: { v = vec4<u32>(0x11131519u, 0x0b0c0d0fu, 0x0708090au, 0x06060607u); }
        case 10u: { v = vec4<u32>(0xafbbc0c0u, 0x66778a9du, 0x353e4957u, 0x1c21262du); }
        case 11u: { v = vec4<u32>(0x10131518u, 0x0a0c0d0eu, 0x07080909u, 0x06060607u); }
        case 12u: { v = vec4<u32>(0xa0a8aaaau, 0x62728293u, 0x333d4754u, 0x1c20252cu); }
        case 13u: { v = vec4<u32>(0x10121518u, 0x0a0b0d0eu, 0x07080809u, 0x05060607u); }
        case 14u: { v = vec4<u32>(0x8e939494u, 0x5c6a7885u, 0x323a4450u, 0x1b1f242au); }
        case 15u: { v = vec4<u32>(0x10121417u, 0x0a0b0c0eu, 0x07070809u, 0x05050606u); }
        case 16u: { v = vec4<u32>(0x7b7e7f7fu, 0x55616c75u, 0x2f37404au, 0x1a1e2328u); }
        case 17u: { v = vec4<u32>(0x0f111316u, 0x090a0c0du, 0x06070808u, 0x05050506u); }
        case 18u: { v = vec4<u32>(0x686a6a6bu, 0x4d565e64u, 0x2c333b44u, 0x181c2126u); }
        case 19u: { v = vec4<u32>(0x0e101215u, 0x090a0b0du, 0x06070708u, 0x04050506u); }
        case 20u: { v = vec4<u32>(0x57585858u, 0x444a5054u, 0x282f353cu, 0x171a1e23u); }
        case 21u: { v = vec4<u32>(0x0d0f1114u, 0x08090b0cu, 0x06060708u, 0x04040505u); }
        case 22u: { v = vec4<u32>(0x47484848u, 0x3a3f4346u, 0x242a2f35u, 0x15181c20u); }
        case 23u: { v = vec4<u32>(0x0d0e1012u, 0x08090a0bu, 0x05060607u, 0x04040405u); }
        case 24u: { v = vec4<u32>(0x3a3a3a3au, 0x31353739u, 0x2024292du, 0x1316191cu); }
        case 25u: { v = vec4<u32>(0x0c0d0f11u, 0x0708090au, 0x05050607u, 0x03040404u); }
        case 26u: { v = vec4<u32>(0x2e2e2e2eu, 0x292b2c2du, 0x1c1f2326u, 0x11141619u); }
        case 27u: { v = vec4<u32>(0x0a0c0d0fu, 0x07070809u, 0x04050506u, 0x03030404u); }
        case 28u: { v = vec4<u32>(0x24242424u, 0x21222324u, 0x181b1d1fu, 0x0f111316u); }
        case 29u: { v = vec4<u32>(0x090b0c0du, 0x06070708u, 0x04040505u, 0x03030304u); }
        case 30u: { v = vec4<u32>(0x1c1c1c1cu, 0x1a1b1c1cu, 0x14161819u, 0x0d0f1112u); }
        case 31u: { v = vec4<u32>(0x08090b0cu, 0x05060707u, 0x04040405u, 0x02030303u); }
        case 32u: { v = vec4<u32>(0x16161616u, 0x15151616u, 0x11121314u, 0x0b0d0e0fu); }
        case 33u: { v = vec4<u32>(0x0708090au, 0x05050607u, 0x03040404u, 0x02020303u); }
        case 34u: { v = vec4<u32>(0x11111111u, 0x10101011u, 0x0d0e0f10u, 0x0a0b0c0du); }
        case 35u: { v = vec4<u32>(0x06070809u, 0x04050506u, 0x03030304u, 0x02020203u); }
        case 36u: { v = vec4<u32>(0x0c0c0c0cu, 0x0c0c0c0cu, 0x0b0b0c0cu, 0x0809090au); }
        case 37u: { v = vec4<u32>(0x05060707u, 0x04040405u, 0x02030303u, 0x02020202u); }
        case 38u: { v = vec4<u32>(0x09090909u, 0x09090909u, 0x08090909u, 0x07070808u); }
        case 39u: { v = vec4<u32>(0x05050606u, 0x03030404u, 0x02020303u, 0x01020202u); }
        case 40u: { v = vec4<u32>(0x07070707u, 0x07070707u, 0x06070707u, 0x05060606u); }
        case 41u: { v = vec4<u32>(0x04040505u, 0x03030303u, 0x02020202u, 0x01010102u); }
        case 42u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x05050505u, 0x04040505u); }
        case 43u: { v = vec4<u32>(0x03030404u, 0x02020303u, 0x02020202u, 0x01010101u); }
        case 44u: { v = vec4<u32>(0x04040404u, 0x04040404u, 0x04040404u, 0x03030304u); }
        case 45u: { v = vec4<u32>(0x03030303u, 0x02020202u, 0x01010202u, 0x01010101u); }
        case 46u: { v = vec4<u32>(0x02020202u, 0x03030302u, 0x03030303u, 0x02030303u); }
        case 47u: { v = vec4<u32>(0x02020202u, 0x01020202u, 0x01010101u, 0x01010101u); }
        case 48u: { v = vec4<u32>(0x02020202u, 0x02020202u, 0x02020202u, 0x02020202u); }
        case 49u: { v = vec4<u32>(0x02020202u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 50u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 51u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00010101u); }
        case 52u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x01010101u); }
        case 53u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x01010101u, 0x00000001u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x01010000u, 0x01010101u); }
        case 55u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00000001u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 24u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xb6d4efffu, 0x576a8099u, 0x28313b48u, 0x13171c21u); }
        case 1u: { v = vec4<u32>(0x0a0c0e10u, 0x06070809u, 0x04040505u, 0x03030304u); }
        case 2u: { v = vec4<u32>(0xb8d6ecfbu, 0x586b819bu, 0x28313b48u, 0x13171c21u); }
        case 3u: { v = vec4<u32>(0x0a0c0e10u, 0x06070809u, 0x04040505u, 0x03030304u); }
        case 4u: { v = vec4<u32>(0xbad4ebf1u, 0x596c839du, 0x28313b49u, 0x13171b21u); }
        case 5u: { v = vec4<u32>(0x0a0c0e10u, 0x06070809u, 0x04040505u, 0x03030304u); }
        case 6u: { v = vec4<u32>(0xb7cfdfe1u, 0x596c839du, 0x28313c49u, 0x13171b21u); }
        case 7u: { v = vec4<u32>(0x0a0c0e10u, 0x06070709u, 0x04040505u, 0x03030304u); }
        case 8u: { v = vec4<u32>(0xafc3cbccu, 0x586b8198u, 0x28313b48u, 0x13171b21u); }
        case 9u: { v = vec4<u32>(0x0a0b0d10u, 0x06060708u, 0x04040505u, 0x03030303u); }
        case 10u: { v = vec4<u32>(0xa2afb4b4u, 0x56687b8fu, 0x27303a47u, 0x12161b20u); }
        case 11u: { v = vec4<u32>(0x0a0b0d10u, 0x06060708u, 0x04040405u, 0x03030303u); }
        case 12u: { v = vec4<u32>(0x90989b9bu, 0x52617283u, 0x262e3844u, 0x12151a1fu); }
        case 13u: { v = vec4<u32>(0x090b0d0fu, 0x05060708u, 0x03040405u, 0x02030303u); }
        case 14u: { v = vec4<u32>(0x7c818283u, 0x4b596773u, 0x242c353fu, 0x1115191eu); }
        case 15u: { v = vec4<u32>(0x090a0c0eu, 0x05060708u, 0x03040404u, 0x02020303u); }
        case 16u: { v = vec4<u32>(0x676a6b6bu, 0x444f5962u, 0x21283039u, 0x1013171cu); }
        case 17u: { v = vec4<u32>(0x080a0b0eu, 0x05050607u, 0x03030404u, 0x02020203u); }
        case 18u: { v = vec4<u32>(0x54565656u, 0x3b434b50u, 0x1e242b33u, 0x0f121519u); }
        case 19u: { v = vec4<u32>(0x08090b0du, 0x04050607u, 0x03030304u, 0x02020202u); }
        case 20u: { v = vec4<u32>(0x42434343u, 0x32383d40u, 0x1b20252bu, 0x0d101317u); }
        case 21u: { v = vec4<u32>(0x07080a0bu, 0x04050506u, 0x02030304u, 0x02020202u); }
        case 22u: { v = vec4<u32>(0x33343434u, 0x292d3032u, 0x171b1f24u, 0x0c0e1114u); }
        case 23u: { v = vec4<u32>(0x0607090au, 0x04040505u, 0x02020303u, 0x01020202u); }
        case 24u: { v = vec4<u32>(0x26272727u, 0x20232426u, 0x13161a1du, 0x0a0c0e11u); }
        case 25u: { v = vec4<u32>(0x06060709u, 0x03040405u, 0x02020203u, 0x01010202u); }
        case 26u: { v = vec4<u32>(0x1c1c1c1cu, 0x181a1b1cu, 0x10121416u, 0x090a0c0eu); }
        case 27u: { v = vec4<u32>(0x05050607u, 0x03030404u, 0x02020202u, 0x01010101u); }
        case 28u: { v = vec4<u32>(0x14141414u, 0x12131314u, 0x0c0e0f11u, 0x0708090bu); }
        case 29u: { v = vec4<u32>(0x04050506u, 0x02030303u, 0x01020202u, 0x01010101u); }
        case 30u: { v = vec4<u32>(0x0d0d0d0du, 0x0d0d0d0du, 0x090a0b0cu, 0x06060708u); }
        case 31u: { v = vec4<u32>(0x03040405u, 0x02020203u, 0x01010102u, 0x01010101u); }
        case 32u: { v = vec4<u32>(0x09090909u, 0x08090909u, 0x07070808u, 0x04050506u); }
        case 33u: { v = vec4<u32>(0x03030304u, 0x02020202u, 0x01010101u, 0x01010101u); }
        case 34u: { v = vec4<u32>(0x05050505u, 0x05050505u, 0x05050505u, 0x03040404u); }
        case 35u: { v = vec4<u32>(0x02020303u, 0x01010202u, 0x01010101u, 0x00010101u); }
        case 36u: { v = vec4<u32>(0x03030303u, 0x03030303u, 0x03030303u, 0x02020303u); }
        case 37u: { v = vec4<u32>(0x01020202u, 0x01010101u, 0x01010101u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x02020202u, 0x01020202u); }
        case 39u: { v = vec4<u32>(0x01010101u, 0x01010101u, 0x00000101u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x01000000u, 0x01010101u, 0x01010101u); }
        case 41u: { v = vec4<u32>(0x01010101u, 0x00010101u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x01010100u); }
        case 43u: { v = vec4<u32>(0x00000001u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 25u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0xa9cbecffu, 0x44576e89u, 0x1a212a35u, 0x0a0d1014u); }
        case 1u: { v = vec4<u32>(0x05060708u, 0x03030304u, 0x02020202u, 0x01010102u); }
        case 2u: { v = vec4<u32>(0xabcee9fau, 0x45576e8au, 0x1a212a36u, 0x0a0d1014u); }
        case 3u: { v = vec4<u32>(0x05060708u, 0x03030304u, 0x02020202u, 0x01010102u); }
        case 4u: { v = vec4<u32>(0xadcce7edu, 0x4558708du, 0x1a212a36u, 0x0a0d1014u); }
        case 5u: { v = vec4<u32>(0x05060708u, 0x03030304u, 0x02020202u, 0x01010102u); }
        case 6u: { v = vec4<u32>(0xa9c5d6d9u, 0x4559708cu, 0x19212a36u, 0x0a0d1014u); }
        case 7u: { v = vec4<u32>(0x05060708u, 0x03030304u, 0x02020202u, 0x01010101u); }
        case 8u: { v = vec4<u32>(0xa0b5bebfu, 0x44576d86u, 0x19202935u, 0x0a0c0f14u); }
        case 9u: { v = vec4<u32>(0x05050708u, 0x02030304u, 0x02020202u, 0x01010101u); }
        case 10u: { v = vec4<u32>(0x8f9da2a2u, 0x4152667bu, 0x181f2833u, 0x090c0f13u); }
        case 11u: { v = vec4<u32>(0x04050608u, 0x02030304u, 0x01020202u, 0x01010101u); }
        case 12u: { v = vec4<u32>(0x7a828585u, 0x3c4b5c6cu, 0x171d252fu, 0x090b0e12u); }
        case 13u: { v = vec4<u32>(0x04050607u, 0x02030303u, 0x01020202u, 0x01010101u); }
        case 14u: { v = vec4<u32>(0x63686969u, 0x35414e5au, 0x151a212au, 0x080a0d10u); }
        case 15u: { v = vec4<u32>(0x04050507u, 0x02020303u, 0x01010202u, 0x01010101u); }
        case 16u: { v = vec4<u32>(0x4c4f5050u, 0x2d363f47u, 0x12171d24u, 0x07090b0eu); }
        case 17u: { v = vec4<u32>(0x03040506u, 0x02020203u, 0x01010102u, 0x01010101u); }
        case 18u: { v = vec4<u32>(0x38393a3au, 0x242a3035u, 0x0f13181du, 0x06080a0cu); }
        case 19u: { v = vec4<u32>(0x03040405u, 0x02020203u, 0x01010101u, 0x01010101u); }
        case 20u: { v = vec4<u32>(0x26272727u, 0x1b1f2225u, 0x0c0f1216u, 0x0506080au); }
        case 21u: { v = vec4<u32>(0x02030404u, 0x01020202u, 0x01010101u, 0x00010101u); }
        case 22u: { v = vec4<u32>(0x18181818u, 0x12141617u, 0x090b0d10u, 0x04050607u); }
        case 23u: { v = vec4<u32>(0x02020303u, 0x01010102u, 0x01010101u, 0x00000001u); }
        case 24u: { v = vec4<u32>(0x0d0d0d0du, 0x0b0c0c0du, 0x0607090au, 0x03040405u); }
        case 25u: { v = vec4<u32>(0x02020203u, 0x01010101u, 0x00010101u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x04040404u, 0x05050505u, 0x04040505u, 0x02030303u); }
        case 27u: { v = vec4<u32>(0x01010202u, 0x01010101u, 0x00000001u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x02020101u, 0x02020202u, 0x01020202u); }
        case 29u: { v = vec4<u32>(0x01010101u, 0x00000101u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x01000000u, 0x01010101u, 0x01010101u); }
        case 31u: { v = vec4<u32>(0x00010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 26u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x96bee6ffu, 0x2e3f5572u, 0x0d121821u, 0x0406070au); }
        case 1u: { v = vec4<u32>(0x02020304u, 0x01010102u, 0x01010101u, 0x00010101u); }
        case 2u: { v = vec4<u32>(0x98c2e5f9u, 0x2e3f5674u, 0x0d121821u, 0x0406070au); }
        case 3u: { v = vec4<u32>(0x02020304u, 0x01010102u, 0x01010101u, 0x00010101u); }
        case 4u: { v = vec4<u32>(0x9ac0e0e7u, 0x2e405775u, 0x0d111821u, 0x0406070au); }
        case 5u: { v = vec4<u32>(0x02020304u, 0x01010102u, 0x01010101u, 0x00010101u); }
        case 6u: { v = vec4<u32>(0x95b5c9ccu, 0x2d3f5674u, 0x0d111821u, 0x04060709u); }
        case 7u: { v = vec4<u32>(0x02020303u, 0x01010102u, 0x01010101u, 0x00000101u); }
        case 8u: { v = vec4<u32>(0x889faaabu, 0x2b3c526cu, 0x0c10171fu, 0x04050709u); }
        case 9u: { v = vec4<u32>(0x02020303u, 0x01010102u, 0x01010101u, 0x00000001u); }
        case 10u: { v = vec4<u32>(0x73818687u, 0x2836495eu, 0x0b0f151du, 0x04050608u); }
        case 11u: { v = vec4<u32>(0x02020203u, 0x01010101u, 0x01010101u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x59616464u, 0x222e3c4cu, 0x0a0d1219u, 0x03040607u); }
        case 13u: { v = vec4<u32>(0x01020203u, 0x01010101u, 0x00010101u, 0x00000000u); }
        case 14u: { v = vec4<u32>(0x3e424444u, 0x1a232d37u, 0x080b0e13u, 0x03040506u); }
        case 15u: { v = vec4<u32>(0x01020202u, 0x01010101u, 0x00000001u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x26272828u, 0x12171d22u, 0x06080b0eu, 0x02030405u); }
        case 17u: { v = vec4<u32>(0x01010202u, 0x01010101u, 0x00000000u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x11111111u, 0x0b0d0f10u, 0x04050709u, 0x02020303u); }
        case 19u: { v = vec4<u32>(0x01010101u, 0x00000101u, 0x00000000u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x03010000u, 0x05050504u, 0x03030404u, 0x01010202u); }
        case 21u: { v = vec4<u32>(0x01010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x00000000u, 0x02020101u, 0x01010202u, 0x01010101u); }
        case 23u: { v = vec4<u32>(0x00000001u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00010101u, 0x00000000u); }
        case 25u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 27u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 29u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 27u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x79aaddffu, 0x17243753u, 0x05070a0fu, 0x02020304u); }
        case 1u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x7caedef6u, 0x17243754u, 0x05070a0fu, 0x02020304u); }
        case 3u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x7dabd3dcu, 0x17243755u, 0x05070a0fu, 0x02020304u); }
        case 5u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x759bb2b5u, 0x16223551u, 0x05070a0eu, 0x01020303u); }
        case 7u: { v = vec4<u32>(0x01010101u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x627b8687u, 0x131e2e46u, 0x0406090du, 0x01020203u); }
        case 9u: { v = vec4<u32>(0x01010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x46535859u, 0x0f172334u, 0x0405070au, 0x01010203u); }
        case 11u: { v = vec4<u32>(0x00010101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x262b2d2du, 0x0a0f161eu, 0x03040507u, 0x01010102u); }
        case 13u: { v = vec4<u32>(0x00000101u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 14u: { v = vec4<u32>(0x0a090808u, 0x0607090bu, 0x02020304u, 0x01010101u); }
        case 15u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x01000000u, 0x02020202u, 0x01010102u, 0x00000001u); }
        case 17u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 19u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 21u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 23u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 25u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 27u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 29u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 28u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x5087cdffu, 0x080e182du, 0x01020305u, 0x00010101u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x528ccfefu, 0x080e182du, 0x01020305u, 0x00010101u); }
        case 3u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x5086bac4u, 0x070d172bu, 0x01020305u, 0x00010101u); }
        case 5u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x41698387u, 0x060b1424u, 0x01020304u, 0x00000101u); }
        case 7u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x26384243u, 0x05080d16u, 0x01010203u, 0x00000001u); }
        case 9u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x0a080402u, 0x02040608u, 0x01010102u, 0x00000000u); }
        case 11u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x01000000u, 0x01010101u, 0x00000000u, 0x00000000u); }
        case 13u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 14u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 15u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 17u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 19u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 21u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 23u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 25u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 27u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 29u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 29u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x1e4da9ffu, 0x0103050cu, 0x00000101u, 0x00000000u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x1e4facdeu, 0x0103050cu, 0x00000101u, 0x00000000u); }
        case 3u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x173d7786u, 0x01020409u, 0x00000001u, 0x00000000u); }
        case 5u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x09101212u, 0x01010204u, 0x00000000u, 0x00000000u); }
        case 7u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 9u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 11u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 13u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 14u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 15u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 17u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 19u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 21u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 23u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 25u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 27u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 29u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 30u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x020b4affu, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x02083783u, 0x00000001u, 0x00000000u, 0x00000000u); }
        case 3u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 5u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 7u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 9u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 11u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 13u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 14u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 15u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 17u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 19u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 21u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 23u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 25u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 27u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 29u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        default: {}
      }
    }
    case 31u: {
      switch (vec_idx & 63u) {
        case 0u: { v = vec4<u32>(0x000002ffu, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 1u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 2u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 3u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 4u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 5u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 6u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 7u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 8u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 9u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 10u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 11u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 12u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 13u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 14u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 15u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 16u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 17u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 18u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 19u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 20u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 21u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 22u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 23u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 24u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 25u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 26u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 27u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 28u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 29u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 30u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 31u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 32u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 33u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 34u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 35u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 36u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 37u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 38u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 39u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 40u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 41u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 42u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 43u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 44u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 45u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 46u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 47u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 48u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 49u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 50u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 51u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 52u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 53u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 54u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 55u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 56u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 57u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 58u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 59u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 60u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 61u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 62u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
        case 63u: { v = vec4<u32>(0x00000000u, 0x00000000u, 0x00000000u, 0x00000000u); }
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

struct BsdfMfEval {
  value: vec3<f32>,
  pdf: f32,
}

struct BsdfMfSample {
  wi: vec3<f32>,
  pdf: f32,
  eval: vec3<f32>,
  is_singular: bool,
}

struct BsdfMfPolarizedFresnel {
  reflectance: vec2<f32>,
  cos_theta_t: f32,
  phasor_real: vec2<f32>,
  is_tir: bool,
}

struct BsdfMfConductorPolarized {
  reflectance: vec2<f32>,
  phasor_s: vec2<f32>,
  phasor_p: vec2<f32>,
}

struct BsdfMfSpecularSetup {
  lobe: Lobe,
  layer_albedo: vec3<f32>,
}

fn bsdf_mf_sqr(x: f32) -> f32 {
  return x * x;
}

fn bsdf_mf_average(v: vec3<f32>) -> f32 {
  return (v.x + v.y + v.z) * BSDF_MF_ONE_THIRD;
}

fn bsdf_mf_max_component(v: vec3<f32>) -> f32 {
  return max(v.x, max(v.y, v.z));
}

fn bsdf_mf_inverse_lerp(a: f32, b: f32, x: f32) -> f32 {
  let denom = b - a;
  if (abs(denom) < 1e-8) {
    return 0.0;
  }
  return (x - a) / denom;
}

fn bsdf_mf_is_singular(alpha_x: f32, alpha_y: f32) -> bool {
  return (alpha_x * alpha_y) <= BSDF_MF_SPECULAR_THRESHOLD;
}

fn bsdf_mf_alpha_to_roughness_index(alpha_x: f32, alpha_y: f32) -> f32 {
  return sqrt(sqrt(max(alpha_x * alpha_y, 0.0)));
}

fn bsdf_mf_ior_to_z_index(ior: f32) -> f32 {
  return sqrt(abs((ior - 1.0) / max(ior + 1.0, 1e-6)));
}

fn bsdf_mf_mu_to_y_index(mu: f32) -> f32 {
  return sqrt(max(mu, 0.0));
}

fn bsdf_mf_zero_guard() -> u32 {
  return select(0u, 1u, kernel_params.image_width == 0xFFFFFFFFu);
}

fn bsdf_mf_fetch_small_u16(word_base: u32, elem_idx: u32) -> f32 {
  let word = bsdf_mf_lut_small_u32(word_base + (elem_idx >> 1u));
  let shift = (elem_idx & 1u) * 16u;
  return f32((word >> shift) & 0xFFFFu) * BSDF_MF_INV_65535;
}

fn bsdf_mf_read_ggx_eavg(x: f32) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let i0 = min(u32(sx), 31u);
  let i1 = min(i0 + 1u, 31u);
  let tx = sx - f32(i0);
  let limit = 2u + bsdf_mf_zero_guard();
  var res = 0.0;
  for (var k: u32 = 0u; k < limit; k = k + 1u) {
    let idx = select(i0, i1, k == 1u);
    let w = select(1.0 - tx, tx, k == 1u);
    res = res + w * bsdf_mf_fetch_small_u16(512u, idx);
  }
  return res;
}

fn bsdf_mf_read_2d_small_u16(word_base: u32, x: f32, y: f32) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sy = clamp(y, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let y0 = min(u32(sy), 31u);
  let y1 = min(y0 + 1u, 31u);
  let tx = sx - f32(x0);
  let ty = sy - f32(y0);
  let limit = 4u + bsdf_mf_zero_guard();
  var res = 0.0;
  for (var corner: u32 = 0u; corner < limit; corner = corner + 1u) {
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cy = select(y0, y1, (corner & 2u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wy = select(1.0 - ty, ty, (corner & 2u) != 0u);
    res = res + (wx * wy) * bsdf_mf_fetch_small_u16(word_base, cy * 32u + cx);
  }
  return res;
}

fn bsdf_mf_read_ggx_e(x: f32, y: f32) -> f32 {
  return bsdf_mf_read_2d_small_u16(0u, x, y);
}

fn bsdf_mf_read_gen_schlick_s(x: f32, y: f32, _z_unused: f32) -> f32 {
  return bsdf_mf_read_2d_small_u16(528u, x, y);
}

fn bsdf_mf_read_gen_schlick_ior_s(x: f32, y: f32, z: f32) -> f32 {
  let sx = clamp(x, 0.0, 1.0) * 31.0;
  let sy = clamp(y, 0.0, 1.0) * 31.0;
  let sz = clamp(z, 0.0, 1.0) * 31.0;
  let x0 = min(u32(sx), 31u);
  let x1 = min(x0 + 1u, 31u);
  let y0 = min(u32(sy), 31u);
  let y1 = min(y0 + 1u, 31u);
  let z0 = min(u32(sz), 31u);
  let z1 = min(z0 + 1u, 31u);
  let tx = sx - f32(x0);
  let ty = sy - f32(y0);
  let tz = sz - f32(z0);
  let limit = 8u + bsdf_mf_zero_guard();
  var res = 0.0;
  for (var corner: u32 = 0u; corner < limit; corner = corner + 1u) {
    let cx = select(x0, x1, (corner & 1u) != 0u);
    let cy = select(y0, y1, (corner & 2u) != 0u);
    let cz = select(z0, z1, (corner & 4u) != 0u);
    let wx = select(1.0 - tx, tx, (corner & 1u) != 0u);
    let wy = select(1.0 - ty, ty, (corner & 2u) != 0u);
    let wz = select(1.0 - tz, tz, (corner & 4u) != 0u);
    let byte_idx = (cz * 32u + cy) * 32u + cx;
    let word = bsdf_mf_lut_ior_s_u32(byte_idx >> 2u);
    let val = f32((word >> ((byte_idx & 3u) * 8u)) & 0xFFu) * BSDF_MF_INV_255;
    res = res + (wx * wy * wz) * val;
  }
  return res;
}

struct BsdfMfSens3M {
  re1: vec3<f32>,
  im1: vec3<f32>,
  re2: vec3<f32>,
  im2: vec3<f32>,
  re3: vec3<f32>,
  im3: vec3<f32>,
}

fn bsdf_mf_iridescence_sensitivities_3m(opd: f32) -> BsdfMfSens3M {
  var out = BsdfMfSens3M(
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    vec3<f32>(0.0),
  );
  let max_idx = u32(BSDF_MF_THIN_FILM_SIZE - 1);
  let scale = f32(BSDF_MF_THIN_FILM_SIZE - 1);
  let limit = 6u + bsdf_mf_zero_guard();
  for (var q: u32 = 0u; q < limit; q = q + 1u) {
    let m_idx = (q >> 1u) + 1u;
    let is_hi = (q & 1u) != 0u;
    let x = clamp(TWO_PI * (f32(m_idx) * opd) / 60000.0, 0.0, 1.0) * scale;
    let i0 = min(u32(x), max_idx);
    let i1 = min(i0 + 1u, max_idx);
    let tx = x - f32(i0);
    let idx = select(i0, i1, is_hi);
    let w = select(1.0 - tx, tx, is_hi);
    let packed = bsdf_mf_lut_thin_film_rgb(idx);
    let sr = unpack2x16float(packed.x);
    let sg = unpack2x16float(packed.y);
    let sb = unpack2x16float(packed.z);
    let re = vec3<f32>(sr.x, sg.x, sb.x) * w;
    let im = vec3<f32>(sr.y, sg.y, sb.y) * w;
    if (m_idx == 1u) {
      out.re1 = out.re1 + re;
      out.im1 = out.im1 + im;
    } else if (m_idx == 2u) {
      out.re2 = out.re2 + re;
      out.im2 = out.im2 + im;
    } else {
      out.re3 = out.re3 + re;
      out.im3 = out.im3 + im;
    }
  }
  return out;
}

fn bsdf_mf_complex_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn bsdf_mf_make_orthonormals(normal: vec3<f32>) -> mat2x3<f32> {
  var axis_a = vec3<f32>(normal.z - normal.y, normal.x - normal.z, normal.y - normal.x);
  if (normal.x == normal.y && normal.x == normal.z) {
    axis_a = vec3<f32>(normal.z - normal.y, normal.x + normal.z, -normal.y - normal.x);
  }
  let tangent = normalize(axis_a);
  let bitangent = cross(normal, tangent);
  return mat2x3<f32>(tangent, bitangent);
}

fn bsdf_mf_make_orthonormals_tangent(normal: vec3<f32>, tangent: vec3<f32>) -> mat2x3<f32> {
  let raw_b = cross(normal, tangent);
  let len_sq = dot(raw_b, raw_b);
  if (len_sq < 1e-8) {
    return bsdf_mf_make_orthonormals(normal);
  }
  let bitangent = raw_b * inverseSqrt(len_sq);
  let ortho_tangent = cross(bitangent, normal);
  return mat2x3<f32>(ortho_tangent, bitangent);
}

fn bsdf_mf_rotate_around_axis(vec: vec3<f32>, axis: vec3<f32>, angle: f32) -> vec3<f32> {
  let cos_a = cos(angle);
  let sin_a = sin(angle);
  let one_minus_cos = 1.0 - cos_a;
  let rx = (cos_a + one_minus_cos * axis.x * axis.x) * vec.x
    + (one_minus_cos * axis.x * axis.y - axis.z * sin_a) * vec.y
    + (one_minus_cos * axis.x * axis.z + axis.y * sin_a) * vec.z;
  let ry = (one_minus_cos * axis.x * axis.y + axis.z * sin_a) * vec.x
    + (cos_a + one_minus_cos * axis.y * axis.y) * vec.y
    + (one_minus_cos * axis.y * axis.z - axis.x * sin_a) * vec.z;
  let rz = (one_minus_cos * axis.x * axis.z - axis.y * sin_a) * vec.x
    + (one_minus_cos * axis.y * axis.z + axis.x * sin_a) * vec.y
    + (cos_a + one_minus_cos * axis.z * axis.z) * vec.z;
  return vec3<f32>(rx, ry, rz);
}

fn bsdf_mf_safe_normalize_fallback(vec: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
  let len_sq = dot(vec, vec);
  if (len_sq > 1e-16) {
    return vec * inverseSqrt(len_sq);
  }
  return fallback;
}

fn bsdf_mf_ensure_valid_specular_reflection(
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  shading_normal: vec3<f32>,
) -> vec3<f32> {
  if (all(geometric_normal == shading_normal)) {
    return shading_normal;
  }
  let iz = dot(wo, geometric_normal);
  if (iz <= 0.0) {
    return shading_normal;
  }
  let reflected = 2.0 * dot(shading_normal, wo) * shading_normal - wo;
  let threshold = min(0.9 * iz, 0.01);
  if (dot(geometric_normal, reflected) >= threshold) {
    return shading_normal;
  }
  let ortho = shading_normal - dot(shading_normal, geometric_normal) * geometric_normal;
  let axis_x = bsdf_mf_safe_normalize_fallback(ortho, shading_normal);
  let ix = dot(wo, axis_x);
  let coeff_a = max(ix * ix + iz * iz, 1e-12);
  let coeff_b = 2.0 * (coeff_a + iz * threshold);
  let coeff_c = bsdf_mf_sqr(threshold + iz);
  let disc = sqrt(max(0.0, coeff_b * coeff_b - 4.0 * coeff_a * coeff_c));
  var nz2 = 0.25 * (coeff_b - disc) / coeff_a;
  if (ix < 0.0) {
    nz2 = 0.25 * (coeff_b + disc) / coeff_a;
  }
  let nx = sqrt(max(0.0, 1.0 - nz2));
  let nz = sqrt(max(0.0, nz2));
  return bsdf_mf_safe_normalize_fallback(nx * axis_x + nz * geometric_normal, geometric_normal);
}

fn bsdf_mf_f0_from_ior(ior: f32) -> f32 {
  return bsdf_mf_sqr((ior - 1.0) / max(ior + 1.0, 1e-6));
}

fn bsdf_mf_ior_from_f0(f0: f32) -> f32 {
  let sqrt_f0 = sqrt(clamp(f0, 0.0, 0.99));
  return (1.0 + sqrt_f0) / (1.0 - sqrt_f0);
}

fn bsdf_mf_fresnel_dielectric_polarized(cos_theta_i: f32, eta: f32) -> BsdfMfPolarizedFresnel {
  let eta_cos_t_sq = eta * eta - (1.0 - cos_theta_i * cos_theta_i);
  if (eta_cos_t_sq <= 0.0) {
    return BsdfMfPolarizedFresnel(vec2<f32>(1.0), 0.0, vec2<f32>(1.0), true);
  }
  let cos_i = abs(cos_theta_i);
  let cos_t = -sqrt(max(0.0, eta_cos_t_sq)) / eta;
  let r_s = (cos_i + eta * cos_t) / max(abs(cos_i - eta * cos_t), 1e-12) * sign(cos_i - eta * cos_t);
  let r_p = (cos_t + eta * cos_i) / max(abs(eta * cos_i - cos_t), 1e-12) * sign(eta * cos_i - cos_t);
  let ph_s = select(-1.0, 1.0, r_s >= 0.0);
  let ph_p = select(-1.0, 1.0, r_p >= 0.0);
  return BsdfMfPolarizedFresnel(vec2<f32>(r_s * r_s, r_p * r_p), cos_t, vec2<f32>(ph_s, ph_p), false);
}

fn bsdf_mf_fresnel_dielectric(cos_theta_i: f32, eta: f32) -> vec2<f32> {
  let pol = bsdf_mf_fresnel_dielectric_polarized(cos_theta_i, eta);
  let f = 0.5 * (pol.reflectance.x + pol.reflectance.y);
  return vec2<f32>(f, pol.cos_theta_t);
}

fn bsdf_mf_fresnel_dielectric_cos(cos_i: f32, eta: f32) -> f32 {
  return bsdf_mf_fresnel_dielectric(cos_i, eta).x;
}

fn bsdf_mf_fresnel_dielectric_fss(eta: f32) -> f32 {
  if (eta < 1.0) {
    return 0.997118 + eta * (0.1014 - eta * (0.965241 + eta * 0.130607));
  }
  return (eta - 1.0) / (4.08567 + 1.00071 * eta);
}

fn bsdf_mf_fresnel_f82tint_b(f0: vec3<f32>, tint: vec3<f32>) -> vec3<f32> {
  let f = 6.0 / 7.0;
  let f5 = f * f * f * f * f;
  let f_schlick = mix(f0, vec3<f32>(1.0), f5);
  return f_schlick * (7.0 / (f5 * f)) * (vec3<f32>(1.0) - tint);
}

fn bsdf_mf_fresnel_f82_b_scalar(f0: f32, f82: f32) -> f32 {
  let f = 6.0 / 7.0;
  let f5 = f * f * f * f * f;
  let f_schlick = mix(f0, 1.0, f5);
  return (7.0 / (f5 * f)) * (f_schlick - f82);
}

fn bsdf_mf_fresnel_f82_fss(f0: vec3<f32>, b_term: vec3<f32>) -> vec3<f32> {
  return mix(f0, vec3<f32>(1.0), 1.0 / 21.0) - b_term * (1.0 / 126.0);
}

fn bsdf_mf_fresnel_f82(cos_i: f32, f0: vec3<f32>, b_term: vec3<f32>) -> vec3<f32> {
  let s = clamp(1.0 - cos_i, 0.0, 1.0);
  let s5 = s * s * s * s * s;
  let f_schlick = mix(f0, vec3<f32>(1.0), s5);
  return clamp(f_schlick - b_term * cos_i * (s5 * s), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn bsdf_mf_fresnel_f82_scalar(cos_i: f32, f0: f32, b_term: f32) -> f32 {
  let s = clamp(1.0 - cos_i, 0.0, 1.0);
  let s5 = s * s * s * s * s;
  let f_schlick = mix(f0, 1.0, s5);
  return clamp(f_schlick - b_term * cos_i * (s5 * s), 0.0, 1.0);
}

fn bsdf_mf_fresnel_conductor_polarized(
  cos_i: f32,
  ambient_ior: f32,
  eta2: f32,
  k2: f32,
  f82_override: f32,
) -> BsdfMfConductorPolarized {
  let eta1 = ambient_ior;
  let eta1_sq = eta1 * eta1;
  let eta2_sq = eta2 * eta2;
  let k2_sq = k2 * k2;
  let two_eta2_k2 = 2.0 * eta2 * k2;
  let t1 = eta2_sq - k2_sq - eta1_sq * (1.0 - cos_i * cos_i);
  let t2 = sqrt(t1 * t1 + two_eta2_k2 * two_eta2_k2);
  let u_sq = max(0.5 * (t2 + t1), 0.0);
  let v_sq = max(0.5 * (t2 - t1), 0.0);
  let u_val = sqrt(u_sq);
  let v_val = sqrt(v_sq);

  var r_s = 0.0;
  var r_p = 0.0;
  if (f82_override >= 0.0) {
    let n_rel = eta2 / max(eta1, 1e-6);
    let k_sq = bsdf_mf_sqr(k2 / max(eta1, 1e-6));
    let f0 = (bsdf_mf_sqr(n_rel - 1.0) + k_sq) / max(bsdf_mf_sqr(n_rel + 1.0) + k_sq, 1e-12);
    r_s = bsdf_mf_fresnel_f82_scalar(cos_i, f0, bsdf_mf_fresnel_f82_b_scalar(f0, f82_override));
    r_p = r_s;
  } else {
    let denom_s = bsdf_mf_sqr(eta1 * cos_i + u_val) + v_sq;
    r_s = select(0.0, (bsdf_mf_sqr(eta1 * cos_i - u_val) + v_sq) / denom_s, denom_s != 0.0);
    let t3 = (eta2_sq - k2_sq) * cos_i;
    let t4 = two_eta2_k2 * cos_i;
    let denom_p = bsdf_mf_sqr(t3 + eta1 * u_val) + bsdf_mf_sqr(t4 + eta1 * v_val);
    r_p = select(0.0, (bsdf_mf_sqr(t3 - eta1 * u_val) + bsdf_mf_sqr(t4 - eta1 * v_val)) / denom_p, denom_p != 0.0);
  }

  let re_s = -u_sq - v_sq + bsdf_mf_sqr(eta1 * cos_i);
  let im_s = -2.0 * eta1 * cos_i * v_val;
  let mag_s = sqrt(re_s * re_s + im_s * im_s);
  let phasor_s = select(vec2<f32>(re_s / max(mag_s, 1e-12), im_s / max(mag_s, 1e-12)), vec2<f32>(1.0, 0.0), mag_s == 0.0);

  let re_p = bsdf_mf_sqr((eta2_sq + k2_sq) * cos_i) - eta1_sq * (u_sq + v_sq);
  let im_p = 2.0 * eta1 * cos_i * (two_eta2_k2 * u_val - (eta2_sq - k2_sq) * v_val);
  let mag_p = sqrt(re_p * re_p + im_p * im_p);
  let phasor_p = select(vec2<f32>(re_p / max(mag_p, 1e-12), im_p / max(mag_p, 1e-12)), vec2<f32>(1.0, 0.0), mag_p == 0.0);

  return BsdfMfConductorPolarized(vec2<f32>(r_s, r_p), phasor_s, phasor_p);
}

fn bsdf_mf_airy_rgb(
  r12: f32,
  r23: f32,
  phasor: vec2<f32>,
  sens: BsdfMfSens3M,
) -> vec3<f32> {
  let t121 = 1.0 - r12;
  let r123 = clamp(r12 * r23, 0.0, 0.999999);
  let root_r123 = sqrt(r123);
  let rs = (t121 * t121) * r23 / (1.0 - r123);
  let p1 = phasor;
  let p2 = bsdf_mf_complex_mul(p1, phasor);
  let p3 = bsdf_mf_complex_mul(p2, phasor);
  let c1 = (rs - t121) * root_r123;
  let c2 = c1 * root_r123;
  let c3 = c2 * root_r123;
  return vec3<f32>(rs + r12)
    + c1 * 2.0 * (p1.x * sens.re1 + p1.y * sens.im1)
    + c2 * 2.0 * (p2.x * sens.re2 + p2.y * sens.im2)
    + c3 * 2.0 * (p3.x * sens.re3 + p3.y * sens.im3);
}

fn bsdf_mf_iridescence_dielectric_rgb(
  film_thickness: f32,
  raw_film_ior: f32,
  substrate_ior: f32,
  cos_theta_1: f32,
) -> vec4<f32> {
  var film_ior = raw_film_ior;
  if (film_thickness < 1.0) {
    film_ior = mix(1.0, film_ior, smoothstep(0.0, 1.0, film_thickness));
  }
  let top = bsdf_mf_fresnel_dielectric_polarized(cos_theta_1, film_ior);
  if (top.is_tir) {
    return vec4<f32>(vec3<f32>(1.0), 0.0);
  }
  let bot = bsdf_mf_fresnel_dielectric_polarized(-top.cos_theta_t, substrate_ior / max(film_ior, 1e-6));
  if (bot.is_tir) {
    return vec4<f32>(vec3<f32>(1.0), 0.0);
  }
  let opd = -2.0 * film_ior * film_thickness * top.cos_theta_t;
  let sens = bsdf_mf_iridescence_sensitivities_3m(opd);
  let phasor_s = vec2<f32>(-top.phasor_real.x * bot.phasor_real.x, 0.0);
  let phasor_p = vec2<f32>(-top.phasor_real.y * bot.phasor_real.y, 0.0);
  let r_s = bsdf_mf_airy_rgb(top.reflectance.x, bot.reflectance.x, phasor_s, sens);
  let r_p = bsdf_mf_airy_rgb(top.reflectance.y, bot.reflectance.y, phasor_p, sens);
  return vec4<f32>(clamp(0.5 * (r_s + r_p), vec3<f32>(0.0), vec3<f32>(1.0)), bot.cos_theta_t);
}

fn bsdf_mf_iridescence_conductor_rgb(
  film_thickness: f32,
  raw_film_ior: f32,
  f0_vec: vec3<f32>,
  b_vec: vec3<f32>,
  cos_theta_1: f32,
) -> vec3<f32> {
  var film_ior = raw_film_ior;
  if (film_thickness < 1.0) {
    film_ior = mix(1.0, film_ior, smoothstep(0.0, 1.0, film_thickness));
  }
  let top = bsdf_mf_fresnel_dielectric_polarized(cos_theta_1, film_ior);
  if (top.is_tir) {
    return vec3<f32>(1.0);
  }
  let opd = -2.0 * film_ior * film_thickness * top.cos_theta_t;
  let sens = bsdf_mf_iridescence_sensitivities_3m(opd);
  var refl = vec3<f32>(0.0);
  for (var ch: i32 = 0; ch < 3; ch = ch + 1) {
    let f0_c = f0_vec[ch];
    let b_c = b_vec[ch];
    let r_c = min(f0_c, 0.999);
    let g_c = bsdf_mf_fresnel_f82_scalar(1.0 / 7.0, f0_c, b_c);
    let sqrt_r = sqrt(max(r_c, 0.0));
    let n_c = mix((1.0 + sqrt_r) / (1.0 - sqrt_r), (1.0 - r_c) / (1.0 + r_c), g_c);
    let k_c = sqrt(max(0.0, (r_c * bsdf_mf_sqr(n_c + 1.0) - bsdf_mf_sqr(n_c - 1.0)) / (1.0 - r_c)));
    let bot = bsdf_mf_fresnel_conductor_polarized(-top.cos_theta_t, film_ior, n_c, k_c, g_c);
    let phasor_s = bot.phasor_s * (-top.phasor_real.x);
    let phasor_p = bot.phasor_p * (-top.phasor_real.y);
    let r_s = bsdf_mf_airy_rgb(top.reflectance.x, bot.reflectance.x, phasor_s, sens)[ch];
    let r_p = bsdf_mf_airy_rgb(top.reflectance.y, bot.reflectance.y, phasor_p, sens)[ch];
    refl[ch] = clamp(0.5 * (r_s + r_p), 0.0, 1.0);
  }
  return refl;
}

fn bsdf_mf_generalized_schlick_eval(
  f0: vec3<f32>,
  ior: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  cos_theta_i: f32,
) -> vec4<f32> {
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    let irid = bsdf_mf_iridescence_dielectric_rgb(thin_film_thickness, thin_film_ior, ior, cos_theta_i);
    var refl = irid.xyz;
    let f0_real = bsdf_mf_f0_from_ior(ior);
    if (f0_real > 1e-5 && any(refl != vec3<f32>(1.0))) {
      let s0 = clamp(bsdf_mf_inverse_lerp(1.0, f0_real, refl.x), 0.0, 1.0);
      let s1 = clamp(bsdf_mf_inverse_lerp(1.0, f0_real, refl.y), 0.0, 1.0);
      let s2 = clamp(bsdf_mf_inverse_lerp(1.0, f0_real, refl.z), 0.0, 1.0);
      refl.x = refl.x * mix(1.0, f0.x / f0_real, s0);
      refl.y = refl.y * mix(1.0, f0.y / f0_real, s1);
      refl.z = refl.z * mix(1.0, f0.z / f0_real, s2);
    }
    return vec4<f32>(clamp(refl, vec3<f32>(0.0), vec3<f32>(1.0)), irid.w);
  }
  let diel = bsdf_mf_fresnel_dielectric(cos_theta_i, ior);
  let f0_real = bsdf_mf_f0_from_ior(ior);
  var s = 1.0;
  if (diel.x < 1.0) {
    s = clamp(bsdf_mf_inverse_lerp(f0_real, 1.0, diel.x), 0.0, 1.0);
  }
  let refl = mix(f0, vec3<f32>(1.0), s);
  return vec4<f32>(refl, diel.y);
}

fn bsdf_mf_eval_glossy_fresnel(lobe: Lobe, cos_theta_i: f32) -> vec3<f32> {
  if ((lobe.flags & LOBE_FLAG_F82_TINT) != 0u) {
    if ((lobe.flags & LOBE_FLAG_THIN_FILM) != 0u && lobe.thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
      return bsdf_mf_iridescence_conductor_rgb(
        lobe.thin_film_thickness,
        lobe.thin_film_ior,
        lobe.f0,
        lobe.f82_or_tint,
        cos_theta_i,
      );
    }
    return bsdf_mf_fresnel_f82(cos_theta_i, lobe.f0, lobe.f82_or_tint);
  }
  return bsdf_mf_generalized_schlick_eval(
    lobe.f0,
    lobe.ior,
    lobe.thin_film_thickness,
    lobe.thin_film_ior,
    cos_theta_i,
  ).xyz;
}

fn bsdf_mf_lambda(alpha2: f32, cos_n: f32) -> f32 {
  let cos2 = max(cos_n * cos_n, 1e-16);
  let sqr_alpha_tan = alpha2 * max(1.0 / cos2 - 1.0, 0.0);
  return 0.5 * (sqrt(1.0 + sqr_alpha_tan) - 1.0);
}

fn bsdf_mf_aniso_lambda(alpha_x: f32, alpha_y: f32, local_v: vec3<f32>) -> f32 {
  let vz2 = max(local_v.z * local_v.z, 1e-16);
  let sqr_alpha_tan = (bsdf_mf_sqr(alpha_x * local_v.x) + bsdf_mf_sqr(alpha_y * local_v.y)) / vz2;
  return 0.5 * (sqrt(1.0 + sqr_alpha_tan) - 1.0);
}

fn bsdf_mf_g1(alpha2: f32, cos_n: f32) -> f32 {
  return 1.0 / (1.0 + bsdf_mf_lambda(alpha2, cos_n));
}

fn bsdf_mf_d(alpha2: f32, cos_nh: f32, sin_nh2: f32) -> f32 {
  let cos_nh2 = min(cos_nh * cos_nh, 1.0);
  let clamped_sin2 = max(sin_nh2, 0.0);
  let denom_term = clamped_sin2 + alpha2 * cos_nh2;
  return alpha2 / max(PI * denom_term * denom_term, 1e-32);
}

fn bsdf_mf_aniso_d(alpha_x: f32, alpha_y: f32, local_h: vec3<f32>) -> f32 {
  let stretched = vec3<f32>(local_h.x / max(alpha_x, 1e-8), local_h.y / max(alpha_y, 1e-8), local_h.z);
  let len2 = dot(stretched, stretched);
  return INV_PI / max(alpha_x * alpha_y * len2 * len2, 1e-32);
}

fn bsdf_mf_sample_vndf(local_wo: vec3<f32>, alpha_x: f32, alpha_y: f32, rand: vec2<f32>) -> vec3<f32> {
  let wi_stretched = normalize(vec3<f32>(alpha_x * local_wo.x, alpha_y * local_wo.y, max(local_wo.z, 0.0)));
  let len_sq = wi_stretched.x * wi_stretched.x + wi_stretched.y * wi_stretched.y;
  var t1 = vec3<f32>(1.0, 0.0, 0.0);
  var t2 = vec3<f32>(0.0, 1.0, 0.0);
  if (len_sq > 1e-7) {
    t1 = vec3<f32>(-wi_stretched.y, wi_stretched.x, 0.0) * inverseSqrt(len_sq);
    t2 = cross(wi_stretched, t1);
  }
  var disk = bsdf_diffuse_sample_uniform_disk(rand);
  disk.y = mix(sqrt(max(0.0, 1.0 - disk.x * disk.x)), disk.y, 0.5 * (1.0 + wi_stretched.z));
  let disk_z = sqrt(max(0.0, 1.0 - dot(disk, disk)));
  let h_hemisphere = disk.x * t1 + disk.y * t2 + disk_z * wi_stretched;
  return normalize(vec3<f32>(alpha_x * h_hemisphere.x, alpha_y * h_hemisphere.y, max(0.0, h_hemisphere.z)));
}

fn bsdf_mf_albedo_coords(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
) -> vec2<f32> {
  let cos_no = max(dot(wo, normal), 0.0);
  if (alpha_x == alpha_y) {
    return vec2<f32>(
      bsdf_mf_alpha_to_roughness_index(alpha_x, alpha_y),
      bsdf_mf_mu_to_y_index(cos_no),
    );
  }
  let frame = bsdf_mf_make_orthonormals_tangent(normal, tangent);
  let lx = dot(frame[0], wo);
  let ly = dot(frame[1], wo);
  let sin2 = lx * lx + ly * ly;
  let ax2 = alpha_x * alpha_x;
  let ay2 = alpha_y * alpha_y;
  let a_rms = sqrt(0.5 * (ax2 + ay2));
  let a_base = 0.82 * a_rms + 0.09 * (alpha_x + alpha_y);
  var a_perp = a_rms;
  var a_az = a_rms;
  if (sin2 > 1e-8) {
    let inv_sin2 = 1.0 / sin2;
    a_perp = sqrt((ax2 * ly * ly + ay2 * lx * lx) * inv_sin2);
    a_az = sqrt((ax2 * lx * lx + ay2 * ly * ly) * inv_sin2);
  }
  let a_eff = clamp(a_base + 0.22 * sin2 * (a_perp - a_rms), 1e-6, 1.0);
  let mu_eff = cos_no * inverseSqrt(max(cos_no * cos_no + sin2 * (a_az / a_eff), 1e-12));
  return vec2<f32>(sqrt(a_eff), bsdf_mf_mu_to_y_index(mu_eff));
}

fn bsdf_mf_albedo_avg_roughness(alpha_x: f32, alpha_y: f32) -> f32 {
  if (alpha_x == alpha_y) {
    return bsdf_mf_alpha_to_roughness_index(alpha_x, alpha_y);
  }
  let a_rms = sqrt(0.5 * (alpha_x * alpha_x + alpha_y * alpha_y));
  let a_base = clamp(0.82 * a_rms + 0.09 * (alpha_x + alpha_y), 1e-6, 1.0);
  return sqrt(a_base);
}

fn bsdf_mf_preserve_energy_glossy(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
  fss: vec3<f32>,
) -> vec4<f32> {
  let coords = bsdf_mf_albedo_coords(normal, tangent, wo, alpha_x, alpha_y);
  let rough_avg = bsdf_mf_albedo_avg_roughness(alpha_x, alpha_y);
  let e_dir = max(bsdf_mf_read_ggx_e(coords.x, coords.y), 1e-5);
  let e_avg = clamp(bsdf_mf_read_ggx_eavg(rough_avg), 1e-5, 1.0);
  let missing_factor = (1.0 - e_dir) / e_dir;
  let energy_scale = 1.0 + missing_factor;
  if (all(fss == vec3<f32>(1.0))) {
    return vec4<f32>(vec3<f32>(1.0), energy_scale);
  }
  let denom = max(vec3<f32>(1.0) - fss * (1.0 - e_avg), vec3<f32>(1e-6));
  let fms = fss * e_avg / denom;
  let darkening = (vec3<f32>(1.0) + fms * missing_factor) / energy_scale;
  return vec4<f32>(darkening, energy_scale);
}

fn bsdf_mf_setup_conductor_lobe(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  f0_color: vec3<f32>,
  f82_tint: vec3<f32>,
  alpha_x: f32,
  alpha_y: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  preserve_energy: bool,
) -> Lobe {
  var lobe: Lobe;
  let ax = clamp(alpha_x, 0.0, 1.0);
  let ay = clamp(alpha_y, 0.0, 1.0);
  let f0 = clamp(f0_color, vec3<f32>(0.0), vec3<f32>(1.0));
  let tint = clamp(f82_tint, vec3<f32>(0.0), vec3<f32>(1.0));
  var b_term = vec3<f32>(0.0);
  if (any(tint != vec3<f32>(1.0))) {
    b_term = bsdf_mf_fresnel_f82tint_b(f0, tint);
  }

  var flags = LOBE_FLAG_F82_TINT;
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    flags = flags | LOBE_FLAG_THIN_FILM;
  }

  lobe.weight = weight;
  lobe.sample_weight = bsdf_mf_average(weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_GLOSSY_GGX;
  lobe.tangent = tangent;
  lobe.flags = flags;
  lobe.f0 = f0;
  lobe.ior = 1.0;
  lobe.f82_or_tint = b_term;
  lobe.diffuse_roughness = 1.0;
  lobe.alpha_x = ax;
  lobe.alpha_y = ay;
  lobe.thin_film_thickness = select(0.0, thin_film_thickness, thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);
  lobe.thin_film_ior = select(0.0, max(thin_film_ior, 1e-5), thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);

  let cos_no = max(dot(wo, normal), 0.0);
  var albedo_est = vec3<f32>(1.0);
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    albedo_est = bsdf_mf_eval_glossy_fresnel(lobe, cos_no);
  } else {
    let coords = bsdf_mf_albedo_coords(normal, tangent, wo, ax, ay);
    let s = bsdf_mf_read_gen_schlick_s(coords.x, coords.y, 0.5);
    albedo_est = mix(f0, vec3<f32>(1.0), s);
  }
  lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(albedo_est);

  if (preserve_energy) {
    lobe.flags = lobe.flags | LOBE_FLAG_MULTISCATTER;
    let fss = clamp(bsdf_mf_fresnel_f82_fss(f0, b_term), vec3<f32>(0.0), vec3<f32>(1.0));
    let pres = bsdf_mf_preserve_energy_glossy(normal, tangent, wo, ax, ay, fss);
    lobe.weight = lobe.weight * pres.xyz;
    lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(pres.xyz);
    lobe.diffuse_roughness = pres.w;
  }
  return lobe;
}

fn bsdf_mf_setup_dielectric_specular_lobe(
  normal: vec3<f32>,
  tangent: vec3<f32>,
  wo: vec3<f32>,
  weight: vec3<f32>,
  f0_color: vec3<f32>,
  eta: f32,
  alpha_x: f32,
  alpha_y: f32,
  thin_film_thickness: f32,
  thin_film_ior: f32,
  preserve_energy: bool,
) -> BsdfMfSpecularSetup {
  var lobe: Lobe;
  let ax = clamp(alpha_x, 0.0, 1.0);
  let ay = clamp(alpha_y, 0.0, 1.0);
  let f0 = clamp(f0_color, vec3<f32>(0.0), vec3<f32>(1.0));

  var flags = 0u;
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    flags = flags | LOBE_FLAG_THIN_FILM;
  }

  lobe.weight = weight;
  lobe.sample_weight = bsdf_mf_average(weight);
  lobe.normal = normal;
  lobe.lobe_type = LOBE_GLOSSY_GGX;
  lobe.tangent = tangent;
  lobe.flags = flags;
  lobe.f0 = f0;
  lobe.ior = eta;
  lobe.f82_or_tint = vec3<f32>(1.0);
  lobe.diffuse_roughness = 1.0;
  lobe.alpha_x = ax;
  lobe.alpha_y = ay;
  lobe.thin_film_thickness = select(0.0, thin_film_thickness, thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);
  lobe.thin_film_ior = select(0.0, max(thin_film_ior, 1e-5), thin_film_thickness > BSDF_MF_THINFILM_CUTOFF);

  let cos_no = max(dot(wo, normal), 0.0);
  var albedo_est = vec3<f32>(0.0);
  if (thin_film_thickness > BSDF_MF_THINFILM_CUTOFF) {
    albedo_est = bsdf_mf_eval_glossy_fresnel(lobe, cos_no);
  } else {
    let coords = bsdf_mf_albedo_coords(normal, tangent, wo, ax, ay);
    let z = bsdf_mf_ior_to_z_index(eta);
    let s = bsdf_mf_read_gen_schlick_ior_s(coords.x, coords.y, z);
    albedo_est = mix(f0, vec3<f32>(1.0), s);
  }
  lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(albedo_est);

  if (preserve_energy) {
    lobe.flags = lobe.flags | LOBE_FLAG_MULTISCATTER;
    let f0_real = bsdf_mf_f0_from_ior(eta);
    let fss_real = bsdf_mf_fresnel_dielectric_fss(eta);
    let s_fss = clamp(bsdf_mf_inverse_lerp(f0_real, 1.0, fss_real), 0.0, 1.0);
    let fss = mix(f0, vec3<f32>(1.0), s_fss);
    let pres = bsdf_mf_preserve_energy_glossy(normal, tangent, wo, ax, ay, fss);
    lobe.weight = lobe.weight * pres.xyz;
    lobe.sample_weight = lobe.sample_weight * bsdf_mf_average(pres.xyz);
    lobe.diffuse_roughness = pres.w;
  }

  let layer_albedo = lobe.weight * bsdf_mf_max_component(albedo_est);
  return BsdfMfSpecularSetup(lobe, layer_albedo);
}

fn bsdf_mf_eval(lobe: Lobe, wi: vec3<f32>, wo: vec3<f32>) -> BsdfMfEval {
  let cos_no = dot(lobe.normal, wo);
  let cos_ni = dot(lobe.normal, wi);
  if (cos_no <= 0.0 || cos_ni <= 0.0 || bsdf_mf_is_singular(lobe.alpha_x, lobe.alpha_y)) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let sum_dir = wo + wi;
  let sum_len_sq = dot(sum_dir, sum_dir);
  if (sum_len_sq <= 1e-16) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }
  let half_vec = sum_dir * inverseSqrt(sum_len_sq);
  let cos_ho = dot(half_vec, wo);
  let cos_nh = dot(lobe.normal, half_vec);
  if (cos_ho <= 0.0 || cos_nh <= 0.0) {
    return BsdfMfEval(vec3<f32>(0.0), 0.0);
  }

  let fresnel = bsdf_mf_eval_glossy_fresnel(lobe, cos_ho);
  var ndf = 0.0;
  var lambda_wo = 0.0;
  var lambda_wi = 0.0;
  if (lobe.alpha_x == lobe.alpha_y) {
    let alpha2 = lobe.alpha_x * lobe.alpha_y;
    let cross_nh = cross(lobe.normal, half_vec);
    ndf = bsdf_mf_d(alpha2, cos_nh, dot(cross_nh, cross_nh));
    lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
    lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  } else {
    let frame = bsdf_mf_make_orthonormals_tangent(lobe.normal, lobe.tangent);
    let local_h = vec3<f32>(dot(frame[0], half_vec), dot(frame[1], half_vec), cos_nh);
    let local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    let local_wi = vec3<f32>(dot(frame[0], wi), dot(frame[1], wi), cos_ni);
    ndf = bsdf_mf_aniso_d(lobe.alpha_x, lobe.alpha_y, local_h);
    lambda_wo = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wo);
    lambda_wi = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wi);
  }

  let common_factor = 0.25 * ndf / cos_no;
  let pdf = common_factor / (1.0 + lambda_wo);
  let energy_scale = lobe.diffuse_roughness;
  let value = lobe.weight * (energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi)) * fresnel;
  return BsdfMfEval(value, pdf);
}

fn bsdf_mf_sample(
  lobe: Lobe,
  geometric_normal: vec3<f32>,
  wo: vec3<f32>,
  rand: vec2<f32>,
) -> BsdfMfSample {
  let cos_no = dot(lobe.normal, wo);
  if (cos_no <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let singular = bsdf_mf_is_singular(lobe.alpha_x, lobe.alpha_y);
  var half_vec = lobe.normal;
  var frame = mat2x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0));
  var local_wo = vec3<f32>(0.0, 0.0, cos_no);
  var local_h = vec3<f32>(0.0, 0.0, 1.0);

  if (!singular) {
    if (lobe.alpha_x == lobe.alpha_y) {
      frame = bsdf_mf_make_orthonormals(lobe.normal);
    } else {
      frame = bsdf_mf_make_orthonormals_tangent(lobe.normal, lobe.tangent);
    }
    local_wo = vec3<f32>(dot(frame[0], wo), dot(frame[1], wo), cos_no);
    local_h = bsdf_mf_sample_vndf(local_wo, lobe.alpha_x, lobe.alpha_y, rand);
    half_vec = local_h.x * frame[0] + local_h.y * frame[1] + local_h.z * lobe.normal;
  }

  let cos_ho = dot(half_vec, wo);
  if (cos_ho <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }
  let wi = 2.0 * cos_ho * half_vec - wo;
  let cos_ni = dot(lobe.normal, wi);
  if (cos_ni <= 0.0 || dot(geometric_normal, wi) <= 0.0) {
    return BsdfMfSample(vec3<f32>(0.0), 0.0, vec3<f32>(0.0), false);
  }

  let fresnel = bsdf_mf_eval_glossy_fresnel(lobe, cos_ho);
  let energy_scale = lobe.diffuse_roughness;
  if (singular) {
    let eval_sing = lobe.weight * fresnel * (energy_scale * BSDF_MF_SINGULAR_WEIGHT);
    return BsdfMfSample(wi, BSDF_MF_SINGULAR_WEIGHT, eval_sing, true);
  }

  var ndf = 0.0;
  var lambda_wo = 0.0;
  var lambda_wi = 0.0;
  if (lobe.alpha_x == lobe.alpha_y) {
    let alpha2 = lobe.alpha_x * lobe.alpha_y;
    ndf = bsdf_mf_d(alpha2, local_h.z, local_h.x * local_h.x + local_h.y * local_h.y);
    lambda_wo = bsdf_mf_lambda(alpha2, cos_no);
    lambda_wi = bsdf_mf_lambda(alpha2, cos_ni);
  } else {
    let local_wi = vec3<f32>(dot(frame[0], wi), dot(frame[1], wi), cos_ni);
    ndf = bsdf_mf_aniso_d(lobe.alpha_x, lobe.alpha_y, local_h);
    lambda_wo = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wo);
    lambda_wi = bsdf_mf_aniso_lambda(lobe.alpha_x, lobe.alpha_y, local_wi);
  }

  let common_factor = 0.25 * ndf / cos_no;
  let pdf = common_factor / (1.0 + lambda_wo);
  let eval_val = lobe.weight * (energy_scale * common_factor / (1.0 + lambda_wo + lambda_wi)) * fresnel;
  return BsdfMfSample(wi, pdf, eval_val, false);
}
